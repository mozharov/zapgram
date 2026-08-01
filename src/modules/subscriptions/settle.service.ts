import {computeSubscriptionFee} from '@core/money/fee.js'
import {classifyPayoutLookup, type PayoutState} from '@core/payments/payout-state.js'
import type {TranslationVariables} from '@grammyjs/i18n'
import type {SubscriptionPayment, User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {ChatWithOwner} from '@modules/chats/types.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {HTTPError} from 'got'
import {MAX_SETTLE_ATTEMPTS} from './payment-repository.js'

export type CompleteSubscriptionPaymentResult = 'settled' | 'kept'

export type DistributeOnceResult = {status: 'paid'; fee: number} | {status: 'pending'}

export type SettleServiceDeps = {
  recordSettleAttempt: (id: string) => Promise<void>
  grantAccess: (payment: SubscriptionPayment, now?: Date) => 'granted' | 'already_settled'
  approveChatJoinRequest: (chatId: number, userId: number) => Promise<void>
  getChatOrThrow: (id: number) => Promise<ChatWithOwner>
  getUserOrThrow: (id: number) => Promise<User>
  deletePayment: (id: string) => Promise<void>
  findSubscriptionByUserAndChat: (
    userId: number,
    chatId: number,
  ) => Promise<{endsAt: Date | null} | null | undefined>
  recordPayoutInvoice: (id: string, hash: string) => Promise<void>
  recordFeePayoutInvoice: (id: string, hash: string) => Promise<void>
  masterWallet: {
    lookupPayment: (hash: string) => Promise<{paid: boolean; status?: string}>
    payInvoice: (bolt11: string) => Promise<unknown>
    createFeeCollectionInvoice: (sats: number) => Promise<{payment_hash: string; bolt11: string}>
  }
  getUserWallet: (userId: number) => Promise<{
    createInvoice: (args: {sats: number}) => Promise<{payment_hash: string; bolt11: string}>
  }>
  notifier: Notifier
  log: AppLogger
  feePercent: number
  translate: (key: string, language?: string, context?: TranslationVariables) => string
  now?: () => Date
}

export type SettleService = {
  complete: (payment: SubscriptionPayment) => Promise<CompleteSubscriptionPaymentResult>
  distributeOnce: (
    payment: SubscriptionPayment,
    chatOwnerId: User['id'],
  ) => Promise<DistributeOnceResult>
}

export function createSettleService(deps: SettleServiceDeps): SettleService {
  const now = deps.now ?? (() => new Date())

  /**
   * Moves the money for a subscription payment at most once: `price - fee` to the chat owner, then
   * `fee` to the fee-collection wallet.
   *
   * Each transfer is its own leg with its own stored hash, so a crash between them cannot re-send the
   * one that already went through. Returns `pending` when LNbits reports a transfer still in flight —
   * the caller must leave the payment row alone and re-check later rather than paying again.
   */
  async function distributeOnce(
    payment: SubscriptionPayment,
    chatOwnerId: User['id'],
  ): Promise<DistributeOnceResult> {
    const fee = computeSubscriptionFee(payment.price, deps.feePercent)

    const ownerLeg = await settleLeg({
      storedHash: payment.payoutHash,
      label: 'owner payout',
      paymentId: payment.id,
      createInvoice: () => createOwnerPayoutInvoice(chatOwnerId, payment.price - fee),
      persistHash: hash => deps.recordPayoutInvoice(payment.id, hash),
    })
    if (ownerLeg === 'pending') return {status: 'pending'}

    if (fee > 0) {
      const feeLeg = await settleLeg({
        storedHash: payment.feePayoutHash,
        label: 'fee collection',
        paymentId: payment.id,
        createInvoice: () => deps.masterWallet.createFeeCollectionInvoice(fee),
        persistHash: hash => deps.recordFeePayoutInvoice(payment.id, hash),
      })
      if (feeLeg === 'pending') return {status: 'pending'}
    }

    return {status: 'paid', fee}
  }

  /**
   * One idempotent outgoing transfer.
   *
   * The hash is persisted *before* the invoice is paid — that ordering is the whole guarantee. A fresh
   * invoice is only issued once LNbits confirms no successful payment exists for the stored hash,
   * which also means an expired invoice from an earlier attempt is simply replaced.
   */
  async function settleLeg({
    storedHash,
    label,
    paymentId,
    createInvoice,
    persistHash,
  }: {
    storedHash: string | null
    label: string
    paymentId: SubscriptionPayment['id']
    createInvoice: () => Promise<{payment_hash: string; bolt11: string}>
    persistHash: (hash: string) => Promise<void>
  }): Promise<'paid' | 'pending'> {
    if (storedHash) {
      const state = await lookupPayoutState(storedHash)
      if (state === 'paid') {
        deps.log.info({paymentId, hash: storedHash}, `${label} already settled; skipping.`)
        return 'paid'
      }
      if (state === 'pending') {
        deps.log.info({paymentId, hash: storedHash}, `${label} still in flight; not re-sending.`)
        return 'pending'
      }
    }

    const invoice = await createInvoice()
    await persistHash(invoice.payment_hash)
    await deps.masterWallet.payInvoice(invoice.bolt11)
    return 'paid'
  }

  async function createOwnerPayoutInvoice(chatOwnerId: User['id'], sats: number) {
    const owner = await deps.getUserOrThrow(chatOwnerId)
    const ownerWallet = await deps.getUserWallet(owner.id)
    return ownerWallet.createInvoice({sats})
  }

  /** A 404 means the master wallet has no payment with this hash, so re-paying is safe. */
  async function lookupPayoutState(hash: string): Promise<PayoutState> {
    try {
      return classifyPayoutLookup(await deps.masterWallet.lookupPayment(hash))
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) return 'retryable'
      throw error
    }
  }

  /**
   * Settle a paid subscription invoice, bounding how many times we retry a payment that keeps failing.
   *
   * The attempt is recorded *before* the work, not after, so a payment that reliably kills the process
   * still burns through its budget instead of retrying forever. Once the budget is gone the cron stops
   * selecting the row (see MAX_SETTLE_ATTEMPTS), but the row itself is never deleted.
   */
  async function complete(
    payment: SubscriptionPayment,
  ): Promise<CompleteSubscriptionPaymentResult> {
    const attempt = payment.settleAttempts + 1
    await deps.recordSettleAttempt(payment.id)

    const result = await settle(payment)

    if (result === 'kept' && attempt >= MAX_SETTLE_ATTEMPTS) {
      deps.log.error(
        {paymentId: payment.id, paymentHash: payment.paymentHash, attempt},
        'Subscription payment exhausted its settle attempts. It will no longer be retried; the row is kept for manual review.',
      )
    }
    return result
  }

  /**
   * Grant access (idempotent), approve join, pay owner, notify.
   *
   * Ordering matters. Everything that can fail is resolved *before* the owner is paid, and the payment
   * row is deleted immediately *after* — so a failure anywhere leaves the row in place for a retry
   * instead of dropping the owner's payout on the floor. Re-running is safe: `settledAt` stops the
   * subscription from being extended twice.
   */
  async function settle(payment: SubscriptionPayment): Promise<CompleteSubscriptionPaymentResult> {
    try {
      deps.log.info({paymentHash: payment.paymentHash}, 'Subscription payment successful.')
      deps.grantAccess(payment, now())

      await deps.approveChatJoinRequest(payment.chatId, payment.userId).catch((error: unknown) => {
        deps.log.error({error}, 'Error while approving chat join request.')
      })

      let chat: ChatWithOwner
      try {
        chat = await deps.getChatOrThrow(payment.chatId)
      } catch (error) {
        deps.log.error({error, chatId: payment.chatId}, 'Failed to get chat information.')
        return 'kept'
      }

      let user: User
      try {
        user = await deps.getUserOrThrow(payment.userId)
      } catch (error) {
        deps.log.error({error, userId: payment.userId}, 'Failed to get user information.')
        return 'kept'
      }

      let payout: DistributeOnceResult
      try {
        payout = await distributeOnce(payment, chat.ownerId)
      } catch (error) {
        deps.log.error({error}, 'Failed to distribute subscription payment.')
        return 'kept'
      }

      if (payout.status === 'pending') {
        deps.log.info(
          {paymentId: payment.id, payoutHash: payment.payoutHash},
          'Owner payout is still in flight at LNbits; re-checking on the next tick.',
        )
        return 'kept'
      }
      const fee = payout.fee

      await deps.deletePayment(payment.id)

      await deps.notifier.send(payment.userId, await buildSubscriberMessage(payment, chat, user))

      await deps.notifier.send(
        chat.ownerId,
        deps.translate('new-subscription-payment', chat.owner.languageCode, {
          username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
          title: chat.title,
          type: payment.subscriptionType,
          price: payment.price,
          fee,
          total: payment.price - fee,
        }),
      )

      return 'settled'
    } catch (error) {
      deps.log.error(
        {error, paymentHash: payment.paymentHash},
        'Error in completeSubscriptionPayment.',
      )
      return 'kept'
    }
  }

  /**
   * A renewal that settles here — because auto-renew handed it over, or because the subscriber paid a
   * renewal invoice by hand — must not be announced as "access received": the subscriber never lost
   * access, and that wording reads like something went wrong.
   *
   * Never throws. It runs after the payment row is deleted, so a failure here must not be mistaken for
   * an unsettled payment; the neutral message is a fine fallback.
   */
  async function buildSubscriberMessage(
    payment: SubscriptionPayment,
    chat: ChatWithOwner,
    user: User,
  ) {
    if (payment.kind === 'renewal') {
      try {
        const subscription = await deps.findSubscriptionByUserAndChat(
          payment.userId,
          payment.chatId,
        )
        if (subscription?.endsAt) {
          return deps.translate('subscription-renewal.renewed', user.languageCode, {
            title: chat.title,
            expiryDate: subscription.endsAt,
            price: payment.price,
          })
        }
      } catch (error) {
        deps.log.error(
          {error, paymentId: payment.id},
          'Could not read the renewed subscription; falling back to the generic paid message.',
        )
      }
    }

    return deps.translate('subscription-invoice.paid', user.languageCode, {
      title: chat.title,
      type: payment.subscriptionType,
    })
  }

  return {complete, distributeOnce}
}
