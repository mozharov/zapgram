import {computeSubscriptionFee} from '@core/money/fee.js'
import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import {classifyPayoutLookup, type PayoutState} from '@core/payments/payout-state.js'
import type {PaidAttemptOutcome} from '@core/subscriptions/payment-attempt.js'
import type {TranslationVariables} from '@grammyjs/i18n'
import type {SubscriptionPayment, User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import {type CaptureClient, captureUserEvent} from '@infra/posthog.js'
import type {ChatWithOwner} from '@modules/chats/types.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {HTTPError} from 'got'
import {MAX_SETTLE_ATTEMPTS} from './payment-repository.js'

export type CompleteSubscriptionPaymentResult = 'settled' | 'kept'

export type DistributePendingLeg = 'owner' | 'fee'

export type DistributeOnceResult =
  | {status: 'paid'; fee: number}
  | {status: 'pending'; leg: DistributePendingLeg; hash: string | null}

export type RefundDuplicateResult = {status: 'credited'} | {status: 'pending'}

export type SettleServiceDeps = {
  recordSettleAttempt: (id: string) => Promise<void>
  claimPaidAttempt: (id: string, claimedAt?: Date) => Promise<PaidAttemptOutcome>
  markWinnerCompleted: (id: string, processedAt?: Date) => Promise<void>
  grantAccess: (payment: SubscriptionPayment, now?: Date) => 'granted' | 'already_settled'
  approveChatJoinRequest: (chatId: number, userId: number) => Promise<void>
  getChatOrThrow: (id: number) => Promise<ChatWithOwner>
  getUserOrThrow: (id: number) => Promise<User>
  findSubscriptionByUserAndChat: (
    userId: number,
    chatId: number,
  ) => Promise<{endsAt: Date | null} | null | undefined>
  recordPayoutInvoice: (id: string, hash: string) => Promise<void>
  recordFeePayoutInvoice: (id: string, hash: string) => Promise<void>
  recordRefundInvoice: (id: string, hash: string) => Promise<void>
  markRefundCredited: (id: string, refundedAt?: Date) => Promise<void>
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
  /** BTC/USD spot for owner/subscriber message suffixes; null omits the suffix. */
  getBtcUsd: () => Promise<number | null>
  posthog?: CaptureClient
  now?: () => Date
}

export type SettleService = {
  complete: (payment: SubscriptionPayment) => Promise<CompleteSubscriptionPaymentResult>
  distributeOnce: (
    payment: SubscriptionPayment,
    chatOwnerId: User['id'],
  ) => Promise<DistributeOnceResult>
  refundDuplicate: (payment: SubscriptionPayment) => Promise<RefundDuplicateResult>
}

export function createSettleService(deps: SettleServiceDeps): SettleService {
  const now = deps.now ?? (() => new Date())

  async function usdSuffixFor(sats: number): Promise<string> {
    const rate = await deps.getBtcUsd()
    return rate === null ? '' : formatUsdSuffix(satsToUsd(sats, rate))
  }

  /** One rate fetch for several amounts (price / fee / total). */
  async function usdSuffixesFor(amounts: number[]): Promise<string[]> {
    const rate = await deps.getBtcUsd()
    if (rate === null) return amounts.map(() => '')
    return amounts.map(sats => formatUsdSuffix(satsToUsd(sats, rate)))
  }

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
    if (ownerLeg === 'pending') {
      return {status: 'pending', leg: 'owner', hash: payment.payoutHash}
    }

    if (fee > 0) {
      const feeLeg = await settleLeg({
        storedHash: payment.feePayoutHash,
        label: 'fee collection',
        paymentId: payment.id,
        createInvoice: () => deps.masterWallet.createFeeCollectionInvoice(fee),
        persistHash: hash => deps.recordFeePayoutInvoice(payment.id, hash),
      })
      if (feeLeg === 'pending') {
        return {status: 'pending', leg: 'fee', hash: payment.feePayoutHash}
      }
    }

    return {status: 'paid', fee}
  }

  /**
   * Credit a duplicate paid attempt back to the subscriber's internal wallet exactly once.
   *
   * The full attempt price is returned without a service fee. The stored refund hash uses the same
   * crash boundary as owner/fee payouts: persist first, pay second, then look it up on every retry.
   */
  async function refundDuplicate(payment: SubscriptionPayment): Promise<RefundDuplicateResult> {
    if (payment.refundedAt) return {status: 'credited'}
    if (payment.attemptStatus === 'processed') {
      throw new Error(`Subscription payment ${payment.id} was processed without a refund`)
    }

    const refundLeg = await settleLeg({
      storedHash: payment.refundPayoutHash,
      label: 'duplicate payment refund',
      paymentId: payment.id,
      createInvoice: async () => {
        const wallet = await deps.getUserWallet(payment.userId)
        return wallet.createInvoice({sats: payment.price})
      },
      persistHash: hash => deps.recordRefundInvoice(payment.id, hash),
    })
    if (refundLeg === 'pending') return {status: 'pending'}

    await deps.markRefundCredited(payment.id, now())
    return {status: 'credited'}
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
    const outcome = await deps.claimPaidAttempt(payment.id, now())
    if (outcome === 'already_processed') return 'settled'

    const attempt = payment.settleAttempts + 1
    await deps.recordSettleAttempt(payment.id)

    const result =
      outcome === 'winner' ? await settleWinner(payment) : await settleDuplicate(payment)

    if (result === 'kept' && attempt >= MAX_SETTLE_ATTEMPTS) {
      deps.log.error(
        {paymentId: payment.id, paymentHash: payment.paymentHash, attempt},
        'Subscription payment exhausted its settle attempts. It will no longer be retried; the row is kept for manual review.',
      )
      captureUserEvent(
        deps.posthog,
        'subscription_settle_exhausted',
        payment.userId,
        {
          payment_id: payment.id,
          chat_id: payment.chatId,
          kind: payment.kind,
          amount_sats: payment.price,
          settle_attempts: attempt,
        },
        {chatId: payment.chatId},
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
   *
   * Join approval is not optional: if Telegram rejects the membership, keep the payment row so the
   * job can retry (or exhaust into manual review). Do not pay the owner or tell the subscriber they
   * have access. Renewals already have membership, so a missing join request only logs.
   */
  async function settleWinner(
    payment: SubscriptionPayment,
  ): Promise<CompleteSubscriptionPaymentResult> {
    try {
      deps.log.info({paymentHash: payment.paymentHash}, 'Subscription payment successful.')
      deps.grantAccess(payment, now())

      try {
        await deps.approveChatJoinRequest(payment.chatId, payment.userId)
      } catch (error) {
        deps.log.error({error}, 'Error while approving chat join request.')
        if (payment.kind === 'join') return 'kept'
      }

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
        const legLabel = payout.leg === 'owner' ? 'Owner payout' : 'Fee collection'
        deps.log.info(
          {paymentId: payment.id, leg: payout.leg, hash: payout.hash},
          `${legLabel} is still in flight at LNbits; re-checking on the next tick.`,
        )
        return 'kept'
      }
      const fee = payout.fee

      await deps.markWinnerCompleted(payment.id, now())

      // `withoutMenu`: the subscriber usually reached us through a join request and may never have
      // pressed /start, so the bot can only write to them inside the join-request window. An
      // "Open wallet" button sends a fresh private message and would 403 once that window closes.
      await deps.notifier.send(
        payment.userId,
        await buildSubscriberMessage(payment, chat, user),
        undefined,
        {withoutMenu: true},
      )

      const total = payment.price - fee
      const [usdSuffix = '', feeUsdSuffix = '', totalUsdSuffix = ''] = await usdSuffixesFor([
        payment.price,
        fee,
        total,
      ])
      await deps.notifier.send(
        chat.ownerId,
        deps.translate('new-subscription-payment', chat.owner.languageCode, {
          username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
          title: chat.title,
          type: payment.subscriptionType,
          price: payment.price,
          usdSuffix,
          fee,
          feeUsdSuffix,
          total,
          totalUsdSuffix,
        }),
      )

      const settleProps = {
        payment_id: payment.id,
        chat_id: payment.chatId,
        kind: payment.kind,
        subscription_type: payment.subscriptionType,
        amount_sats: payment.price,
        fee_sats: fee,
        owner_sats: payment.price - fee,
        payment_method: 'lightning' as const,
      }
      captureUserEvent(deps.posthog, 'subscription_settled', payment.userId, settleProps, {
        chatId: payment.chatId,
      })
      captureUserEvent(
        deps.posthog,
        'subscription_payment_received',
        chat.ownerId,
        {
          ...settleProps,
          subscriber_id: payment.userId,
        },
        {chatId: payment.chatId},
      )

      return 'settled'
    } catch (error) {
      deps.log.error(
        {error, paymentHash: payment.paymentHash},
        'Error settling subscription payment.',
      )
      return 'kept'
    }
  }

  /** Refund a paid non-winning attempt without granting access or paying the chat owner again. */
  async function settleDuplicate(
    payment: SubscriptionPayment,
  ): Promise<CompleteSubscriptionPaymentResult> {
    try {
      const user = await deps.getUserOrThrow(payment.userId)
      const refund = await refundDuplicate(payment)
      if (refund.status === 'pending') {
        deps.log.info(
          {paymentId: payment.id, refundPayoutHash: payment.refundPayoutHash},
          'Duplicate payment refund is still in flight at LNbits; re-checking on the next tick.',
        )
        return 'kept'
      }

      await deps.notifier.send(
        payment.userId,
        deps.translate('subscription-invoice.duplicate-refunded', user.languageCode, {
          price: payment.price,
          usdSuffix: await usdSuffixFor(payment.price),
        }),
      )
      captureUserEvent(
        deps.posthog,
        'subscription_duplicate_refunded',
        payment.userId,
        {
          payment_id: payment.id,
          chat_id: payment.chatId,
          kind: payment.kind,
          amount_sats: payment.price,
        },
        {chatId: payment.chatId},
      )
      return 'settled'
    } catch (error) {
      deps.log.error(
        {error, paymentHash: payment.paymentHash},
        'Error refunding duplicate subscription payment.',
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
            usdSuffix: await usdSuffixFor(payment.price),
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

  return {complete, distributeOnce, refundDuplicate}
}
