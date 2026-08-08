import type {PaidAttemptOutcome} from '@core/subscriptions/payment-attempt.js'
import type {TranslationVariables} from '@grammyjs/i18n'
import type {Chat, OnchainChatPayment, SubscriptionPayment, User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {ChatWithOwner} from '@modules/chats/types.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import type {OnchainPaymentRepository} from './repository.js'
import {extractTxidFromChargeExtra} from './txid.js'

export type CompleteOnchainResult = 'settled' | 'already_settled' | 'kept' | 'not_found'

export type CompleteOnchainJoinDeps = {
  onchainPayments: OnchainPaymentRepository
  createSubscriptionPayment: (data: {
    userId: number
    chatId: number
    paymentRequest: string
    paymentHash: string
    price: number
    subscriptionType: 'one_time' | 'monthly'
    kind: 'join'
    expiresAt: Date
  }) => Promise<SubscriptionPayment>
  findSubscriptionPayment: (id: string) => Promise<SubscriptionPayment | null | undefined>
  claimPaidAttempt: (id: string, claimedAt?: Date) => Promise<PaidAttemptOutcome>
  markWinnerCompleted: (id: string, processedAt?: Date) => Promise<void>
  grantAccess: (payment: SubscriptionPayment, now?: Date) => 'granted' | 'already_settled'
  approveChatJoinRequest: (chatId: number, userId: number) => Promise<void>
  getChatOrThrow: (id: number) => Promise<ChatWithOwner>
  getUserOrThrow: (id: number) => Promise<User>
  notifier: Notifier
  /** Best-effort edit of the address payment message (never throws into settle). */
  editTelegramMessage?: (
    telegramChatId: number,
    telegramMessageId: number,
    text: string,
  ) => Promise<void>
  log: AppLogger
  translate: (key: string, language?: string, context?: TranslationVariables) => string
  now?: () => Date
}

/**
 * Grant access after a SatsPay on-chain charge is paid.
 * No owner LN payout / platform fee — funds already sit on the admin's chain wallet.
 */
export function createCompleteOnchainJoinService(deps: CompleteOnchainJoinDeps) {
  const now = deps.now ?? (() => new Date())

  return {
    async completeFromCharge(args: {
      chargeId: string
      paid: boolean
      extra?: string | null
      amount?: number
    }): Promise<CompleteOnchainResult> {
      if (!args.paid) return 'kept'

      const onchain = await deps.onchainPayments.findByChargeId(args.chargeId)
      if (!onchain) {
        deps.log.warn({chargeId: args.chargeId}, 'SatsPay webhook for unknown charge')
        return 'not_found'
      }
      if (onchain.status === 'paid') return 'already_settled'
      if (onchain.status === 'expired' || onchain.status === 'cancelled') {
        deps.log.warn(
          {chargeId: args.chargeId, status: onchain.status},
          'On-chain charge paid after terminal status; not granting',
        )
        return 'kept'
      }

      return settleOnchain(onchain, extractTxidFromChargeExtra(args.extra))
    },

    async complete(
      onchain: OnchainChatPayment,
      txid?: string | null,
    ): Promise<CompleteOnchainResult> {
      if (onchain.status === 'paid') return 'already_settled'
      if (onchain.status !== 'pending' && onchain.status !== 'grace') return 'kept'
      return settleOnchain(onchain, txid ?? onchain.txid)
    },
  }

  async function settleOnchain(
    onchain: OnchainChatPayment,
    txid: string | null | undefined,
  ): Promise<CompleteOnchainResult> {
    try {
      let subscriptionPayment: SubscriptionPayment | null | undefined
      if (onchain.subscriptionPaymentId) {
        subscriptionPayment = await deps.findSubscriptionPayment(onchain.subscriptionPaymentId)
      }
      if (!subscriptionPayment) {
        const chat = await deps.getChatOrThrow(onchain.chatId)
        subscriptionPayment = await deps.createSubscriptionPayment({
          userId: onchain.userId,
          chatId: onchain.chatId,
          paymentRequest: onchainPaymentRequest(onchain.satspayChargeId),
          paymentHash: onchainPaymentHash(onchain.satspayChargeId),
          price: onchain.amountSats,
          subscriptionType: chat.paymentType,
          kind: 'join',
          expiresAt: onchain.expiresAt,
        })
        await deps.onchainPayments.linkSubscriptionPayment(onchain.id, subscriptionPayment.id)
      }

      const claim = await deps.claimPaidAttempt(subscriptionPayment.id, now())
      if (claim === 'already_processed') {
        await deps.onchainPayments.markPaid(onchain.id, {
          paidAt: now(),
          txid,
          subscriptionPaymentId: subscriptionPayment.id,
        })
        return 'already_settled'
      }
      if (claim === 'already_won_refund') {
        // Another attempt already won (e.g. LN paid first). Mark on-chain paid for bookkeeping only.
        deps.log.info(
          {onchainId: onchain.id, paymentId: subscriptionPayment.id},
          'On-chain payment arrived after another attempt already won; not granting again',
        )
        await deps.onchainPayments.markPaid(onchain.id, {
          paidAt: now(),
          txid,
          subscriptionPaymentId: subscriptionPayment.id,
        })
        return 'already_settled'
      }

      deps.grantAccess(subscriptionPayment, now())

      try {
        await deps.approveChatJoinRequest(onchain.chatId, onchain.userId)
      } catch (error) {
        deps.log.error({error}, 'Error while approving chat join request (on-chain).')
        return 'kept'
      }

      let chat: ChatWithOwner
      let user: User
      try {
        chat = await deps.getChatOrThrow(onchain.chatId)
        user = await deps.getUserOrThrow(onchain.userId)
      } catch (error) {
        deps.log.error({error}, 'Failed to load chat/user after on-chain grant')
        return 'kept'
      }

      // Stamp on-chain paid *before* markWinnerCompleted: legacy intents cascade-delete the
      // subscription_payments row when the intent is removed, which would break the FK.
      await deps.onchainPayments.markPaid(onchain.id, {
        paidAt: now(),
        txid,
        subscriptionPaymentId: subscriptionPayment.id,
      })
      await deps.markWinnerCompleted(subscriptionPayment.id, now())

      const paidText = deps.translate('onchain-invoice.paid', user.languageCode, {
        title: chat.title,
        type: subscriptionPayment.subscriptionType,
      })

      if (
        deps.editTelegramMessage &&
        onchain.telegramChatId != null &&
        onchain.telegramMessageId != null
      ) {
        try {
          await deps.editTelegramMessage(
            onchain.telegramChatId,
            onchain.telegramMessageId,
            paidText,
          )
        } catch (error) {
          deps.log.debug(
            {error, onchainId: onchain.id},
            'Could not edit on-chain payment message after settle',
          )
        }
      }

      await deps.notifier.send(onchain.userId, paidText)

      await deps.notifier.send(
        chat.ownerId,
        deps.translate('new-onchain-subscription-payment', chat.owner.languageCode, {
          username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
          title: chat.title,
          type: subscriptionPayment.subscriptionType,
          price: onchain.amountSats,
          address: onchain.address,
        }),
      )

      return 'settled'
    } catch (error) {
      deps.log.error(
        {error, chargeId: onchain.satspayChargeId},
        'Error completing on-chain subscription payment',
      )
      return 'kept'
    }
  }
}

export type CompleteOnchainJoinService = ReturnType<typeof createCompleteOnchainJoinService>

export function onchainPaymentHash(chargeId: string): string {
  return `onchain:${chargeId}`
}

export function onchainPaymentRequest(chargeId: string): string {
  return `onchain:${chargeId}`
}

/** Chat is ready for on-chain member payments. */
export function chatAllowsOnchain(
  chat: Pick<Chat, 'onchainEnabled' | 'watchonlyWalletId'>,
): boolean {
  return Boolean(chat.onchainEnabled && chat.watchonlyWalletId)
}
