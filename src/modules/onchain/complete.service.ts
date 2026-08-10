import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import type {PaidAttemptOutcome} from '@core/subscriptions/payment-attempt.js'
import type {TranslationVariables} from '@grammyjs/i18n'
import type {
  Chat,
  OnchainChatPayment,
  SubscriptionIntent,
  SubscriptionPayment,
  User,
} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import {type CaptureClient, captureUserEvent} from '@infra/posthog.js'
import type {ChatWithOwner} from '@modules/chats/types.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import type {OnchainPaymentRepository} from './repository.js'
import {extractTxidFromChargeExtra} from './txid.js'

export type CompleteOnchainResult = 'settled' | 'already_settled' | 'kept' | 'not_found'

/** How paid was observed — used on settle + terminal-late analytics. */
export type OnchainDetectionSource = 'webhook' | 'cron'

export type CompleteOnchainJoinDeps = {
  onchainPayments: OnchainPaymentRepository
  /**
   * Shared join intent for (user, chat). On-chain and LN attempts share this intent
   * so either rail can win without a second intent row.
   */
  getOrCreateJoinIntent: (
    userId: number,
    chatId: number,
  ) => Promise<{
    intent: Pick<SubscriptionIntent, 'id'>
    currentAttempt: Pick<SubscriptionPayment, 'id'> | null | undefined
  }>
  createSubscriptionPayment: (data: {
    intentId: string
    userId: number
    chatId: number
    paymentRequest: string
    paymentHash: string
    price: number
    subscriptionType: 'one_time' | 'monthly'
    kind: 'join'
    expiresAt: Date
    isCurrent?: boolean
  }) => Promise<SubscriptionPayment>
  findSubscriptionPayment: (id: string) => Promise<SubscriptionPayment | null | undefined>
  /** Idempotent lookup when create already ran (webhook/cron race). */
  findSubscriptionPaymentByHash: (
    paymentHash: string,
  ) => Promise<SubscriptionPayment | null | undefined>
  claimPaidAttempt: (id: string, claimedAt?: Date) => Promise<PaidAttemptOutcome>
  markWinnerCompleted: (id: string, processedAt?: Date) => Promise<void>
  grantAccess: (payment: SubscriptionPayment, now?: Date) => 'granted' | 'already_settled'
  approveChatJoinRequest: (chatId: number, userId: number) => Promise<void>
  getChatOrThrow: (id: number) => Promise<ChatWithOwner>
  getUserOrThrow: (id: number) => Promise<User>
  notifier: Notifier
  /** Edit the join/on-chain invoice message in-place (users who never /start cannot get new DMs). */
  editTelegramMessage?: (
    telegramChatId: number,
    telegramMessageId: number,
    text: string,
  ) => Promise<void>
  log: AppLogger
  translate: (key: string, language?: string, context?: TranslationVariables) => string
  /** BTC/USD spot for owner notify amount suffix; null omits the suffix. */
  getBtcUsd: () => Promise<number | null>
  posthog?: CaptureClient
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
      /** Default webhook — only override in tests. */
      source?: OnchainDetectionSource
    }): Promise<CompleteOnchainResult> {
      const source = args.source ?? 'webhook'
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
        captureUserEvent(
          deps.posthog,
          'onchain_paid_after_terminal',
          onchain.userId,
          {
            charge_id: args.chargeId,
            onchain_id: onchain.id,
            chat_id: onchain.chatId,
            amount_sats: onchain.amountSats,
            status: onchain.status,
            detection_source: source,
          },
          {chatId: onchain.chatId},
        )
        return 'kept'
      }

      return settleOnchain(onchain, extractTxidFromChargeExtra(args.extra), source)
    },

    async complete(
      onchain: OnchainChatPayment,
      txid?: string | null,
      source: OnchainDetectionSource = 'cron',
    ): Promise<CompleteOnchainResult> {
      if (onchain.status === 'paid') return 'already_settled'
      if (onchain.status !== 'pending' && onchain.status !== 'grace') {
        if (onchain.status === 'expired' || onchain.status === 'cancelled') {
          captureUserEvent(
            deps.posthog,
            'onchain_paid_after_terminal',
            onchain.userId,
            {
              charge_id: onchain.satspayChargeId,
              onchain_id: onchain.id,
              chat_id: onchain.chatId,
              amount_sats: onchain.amountSats,
              status: onchain.status,
              detection_source: source,
            },
            {chatId: onchain.chatId},
          )
        }
        return 'kept'
      }
      return settleOnchain(onchain, txid ?? onchain.txid, source)
    },
  }

  async function settleOnchain(
    onchain: OnchainChatPayment,
    txid: string | null | undefined,
    source: OnchainDetectionSource,
  ): Promise<CompleteOnchainResult> {
    try {
      const paymentHash = onchainPaymentHash(onchain.satspayChargeId)
      let subscriptionPayment: SubscriptionPayment | null | undefined

      if (onchain.subscriptionPaymentId) {
        subscriptionPayment = await deps.findSubscriptionPayment(onchain.subscriptionPaymentId)
      }
      if (!subscriptionPayment) {
        subscriptionPayment = await deps.findSubscriptionPaymentByHash(paymentHash)
      }

      if (!subscriptionPayment) {
        const chat = await deps.getChatOrThrow(onchain.chatId)
        const {intent, currentAttempt} = await deps.getOrCreateJoinIntent(
          onchain.userId,
          onchain.chatId,
        )
        subscriptionPayment = await deps.createSubscriptionPayment({
          intentId: intent.id,
          userId: onchain.userId,
          chatId: onchain.chatId,
          paymentRequest: onchainPaymentRequest(onchain.satspayChargeId),
          paymentHash,
          price: onchain.amountSats,
          subscriptionType: chat.paymentType,
          kind: 'join',
          expiresAt: onchain.expiresAt,
          // Only one is_current=1 per intent; LN join attempt usually already holds it.
          isCurrent: !currentAttempt,
        })
      }

      await deps.onchainPayments.linkSubscriptionPayment(onchain.id, subscriptionPayment.id)

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

      // Always edit the payment message (join-request users often never /start;
      // a new DM would 403, and the address invoice is obsolete after settle).
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

      // Owner almost always has an open chat with the bot (admin).
      const rate = await deps.getBtcUsd()
      const usdSuffix = rate === null ? '' : formatUsdSuffix(satsToUsd(onchain.amountSats, rate))
      await deps.notifier.send(
        chat.ownerId,
        deps.translate('new-onchain-subscription-payment', chat.owner.languageCode, {
          username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
          title: chat.title,
          type: subscriptionPayment.subscriptionType,
          price: onchain.amountSats,
          usdSuffix,
          address: onchain.address,
        }),
      )

      const settleProps = {
        payment_id: subscriptionPayment.id,
        chat_id: onchain.chatId,
        kind: 'join' as const,
        subscription_type: subscriptionPayment.subscriptionType,
        amount_sats: onchain.amountSats,
        fee_sats: 0,
        owner_sats: onchain.amountSats,
        payment_method: 'onchain' as const,
        detection_source: source,
        charge_id: onchain.satspayChargeId,
        address: onchain.address,
        txid: txid ?? null,
      }
      captureUserEvent(deps.posthog, 'subscription_settled', onchain.userId, settleProps, {
        chatId: onchain.chatId,
      })
      captureUserEvent(
        deps.posthog,
        'subscription_payment_received',
        chat.ownerId,
        {
          ...settleProps,
          subscriber_id: onchain.userId,
        },
        {chatId: onchain.chatId},
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

/** Synthetic payment_hash for SatsPay charges — never a LNbits LN payment id. */
export function isOnchainPaymentHash(paymentHash: string): boolean {
  return paymentHash.startsWith('onchain:')
}

/** Chat is ready for on-chain member payments. */
export function chatAllowsOnchain(
  chat: Pick<Chat, 'onchainEnabled' | 'watchonlyWalletId'>,
): boolean {
  return Boolean(chat.onchainEnabled && chat.watchonlyWalletId)
}
