import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import type {TranslationVariables} from '@grammyjs/i18n'
import type {Chat, Subscription, SubscriptionPayment, User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {InputFile} from 'grammy'
import QRCode from 'qrcode'
import type {CompleteSubscriptionPaymentResult} from './settle.service.js'
import {buildSubscriptionPaymentKeyboard} from './telegram/keyboards/subscription-payment.js'

/**
 * `renewed` — settle finished fully (access granted, owner paid, messages sent by settle).
 * `handed_off` — charge done or in-flight row exists; settle cron / settle service owns the rest.
 *   This job must stay quiet on notifications, or the user would get notified twice.
 * `failed` — nothing was collected, fall back to sending a manual invoice.
 */
export type RenewalOutcome = {status: 'renewed'} | {status: 'handed_off'} | {status: 'failed'}

export type RenewalServiceDeps = {
  getPendingPaymentForSubscription: (
    userId: number,
    chatId: number,
  ) => Promise<SubscriptionPayment | null | undefined>
  createSubscriptionPayment: (data: {
    chatId: number
    userId: number
    paymentHash: string
    paymentRequest: string
    subscriptionType: 'monthly'
    price: number
    kind: 'renewal'
  }) => Promise<SubscriptionPayment>
  masterWallet: {
    createInvoice: (sats: number, expiry: number) => Promise<{payment_hash: string; bolt11: string}>
    lookupPayment: (paymentHash: string) => Promise<{paid: boolean}>
  }
  getUserWallet: (userId: number) => Promise<{
    payInvoice: (bolt11: string) => Promise<unknown>
  }>
  /** Stored NWC connection string for the subscriber, if any. */
  getUserNwcUrl: (userId: number) => Promise<string | null | undefined>
  /** Build an NWC client from a stored URL for auto-renew fallback. */
  createNwc: (nwcUrl: string) => {payInvoice: (bolt11: string) => Promise<unknown>}
  /** Single settlement path — grant access, pay owner, notify. */
  completePayment: (payment: SubscriptionPayment) => Promise<CompleteSubscriptionPaymentResult>
  notifier: Notifier
  log: AppLogger
  translate: (key: string, language?: string, context?: TranslationVariables) => string
  /** BTC/USD spot for renewal reminder amount suffix; null omits the suffix. */
  getBtcUsd: () => Promise<number | null>
  invoiceExpirySeconds: number
}

export type RenewalService = {
  attemptAutoRenewal: (subscription: Subscription, chat: Chat) => Promise<RenewalOutcome>
  /**
   * `true` only when the subscriber received a usable renewal reminder (invoice minted or
   * reused, and Telegram accepted the photo). Callers must not set `notificationSent` otherwise.
   */
  createAndSendRenewalInvoice: (
    subscription: Subscription,
    chat: Chat,
    user: User,
  ) => Promise<boolean>
}

export function createRenewalService(deps: RenewalServiceDeps): RenewalService {
  /**
   * Charges the subscriber and hands settlement to the settle service.
   *
   * The payment row is written *before* the subscriber is charged. After a successful charge,
   * `completePayment` runs the single grant → pay owner → notify path. Anything that goes wrong
   * leaves that row on disk, where the subscription payment cron picks it up and finishes the job
   * idempotently — so a failure cannot collect money from a subscriber and deliver nothing.
   */
  async function attemptAutoRenewal(
    subscription: Subscription,
    _chat: Chat,
  ): Promise<RenewalOutcome> {
    let payment: SubscriptionPayment
    try {
      if (!subscription.autoRenew || !subscription.endsAt) return {status: 'failed'}

      // An existing row means an earlier attempt is still owned by the settle cron. Charging again
      // here is how a subscriber would get billed twice.
      const inFlight = await deps.getPendingPaymentForSubscription(
        subscription.userId,
        subscription.chatId,
      )
      if (inFlight) {
        deps.log.info(
          {subscriptionId: subscription.id, paymentId: inFlight.id},
          'A subscription payment is already in flight; leaving this renewal to the settle cron.',
        )
        return {status: 'handed_off'}
      }

      const invoice = await deps.masterWallet.createInvoice(
        subscription.price,
        deps.invoiceExpirySeconds,
      )
      payment = await deps.createSubscriptionPayment({
        chatId: subscription.chatId,
        userId: subscription.userId,
        paymentHash: invoice.payment_hash,
        paymentRequest: invoice.bolt11,
        subscriptionType: 'monthly',
        price: subscription.price,
        kind: 'renewal',
      })

      // Internal balance first, then NWC. After any failed rail, re-check the master invoice so
      // LNbits lag (or NWC "already paid") cannot double-charge and still can settle a paid row.
      const charged = await chargeSubscriber(subscription, invoice.bolt11, payment.paymentHash)
      if (!charged) return {status: 'failed'}
    } catch (error) {
      deps.log.error({error, subscriptionId: subscription.id}, 'Error in attemptAutoRenewal')
      return {status: 'failed'}
    }

    // Past this point the subscriber has paid, so we never report failure — the row guarantees the
    // renewal is completed by someone, and reporting failure would invoice the user a second time.
    // Settlement (grant → pay owner → notify) is owned exclusively by the settle service.
    try {
      const settleResult = await deps.completePayment(payment)
      if (settleResult === 'settled') return {status: 'renewed'}
      deps.log.info(
        {subscriptionId: subscription.id, paymentId: payment.id},
        'Renewal payout still in flight or incomplete; the settle cron will finish it.',
      )
      return {status: 'handed_off'}
    } catch (error) {
      deps.log.error(
        {error, subscriptionId: subscription.id, paymentId: payment.id},
        'Renewal could not be completed here; leaving the payment row for the settle cron.',
      )
      return {status: 'handed_off'}
    }
  }

  /**
   * Collect the renewal amount from the subscriber.
   *
   * Order: ZapGram balance → (if unpaid) NWC → (if still unpaid after NWC) give up.
   * Between rails we re-check the master invoice so a laggy success is not charged twice.
   */
  async function chargeSubscriber(
    subscription: Subscription,
    bolt11: string,
    paymentHash: string,
  ): Promise<boolean> {
    if ((await attemptPaymentFromBalance(subscription, bolt11)).success) return true

    if (await isMasterInvoicePaid(paymentHash)) {
      deps.log.info(
        {subscriptionId: subscription.id, paymentHash},
        'Balance charge reported failure but the renewal invoice is paid; settling it.',
      )
      return true
    }

    if ((await attemptPaymentFromNwc(subscription, bolt11)).success) return true

    if (await isMasterInvoicePaid(paymentHash)) {
      deps.log.info(
        {subscriptionId: subscription.id, paymentHash},
        'NWC charge reported failure but the renewal invoice is paid; settling it.',
      )
      return true
    }

    return false
  }

  async function attemptPaymentFromBalance(subscription: Subscription, invoice: string) {
    try {
      deps.log.info(`Attempting payment from balance for subscription ${subscription.id}`)
      const wallet = await deps.getUserWallet(subscription.userId)
      const result = await wallet.payInvoice(invoice).catch((error: unknown) => {
        deps.log.error({error}, 'Error paying invoice from balance')
        return null
      })
      return {success: !!result}
    } catch (error) {
      deps.log.error({error, subscriptionId: subscription.id}, 'Error in attemptPaymentFromBalance')
      return {success: false}
    }
  }

  async function attemptPaymentFromNwc(subscription: Subscription, invoice: string) {
    try {
      const nwcUrl = await deps.getUserNwcUrl(subscription.userId)
      if (!nwcUrl) {
        deps.log.info(
          {subscriptionId: subscription.id, userId: subscription.userId},
          'No NWC URL for auto-renew fallback',
        )
        return {success: false}
      }
      deps.log.info(
        {subscriptionId: subscription.id, userId: subscription.userId},
        'Attempting auto-renew payment from NWC',
      )
      const nwc = deps.createNwc(nwcUrl)
      await nwc.payInvoice(invoice)
      return {success: true}
    } catch (error) {
      deps.log.error({error, subscriptionId: subscription.id}, 'Error paying renewal invoice via NWC')
      return {success: false}
    }
  }

  async function isMasterInvoicePaid(paymentHash: string): Promise<boolean> {
    try {
      const lookup = await deps.masterWallet.lookupPayment(paymentHash)
      return lookup.paid
    } catch (error) {
      deps.log.error(
        {error, paymentHash},
        'Could not look up renewal invoice after a charge failure',
      )
      return false
    }
  }

  /**
   * Sends a manual renewal reminder. Reuses an in-flight renewal payment when auto-charge already
   * minted one — never a second BOLT11 for the same window, which would leave an orphan unpaid row.
   *
   * Returns whether the photo was delivered. Mint/QR/Telegram failures leave the subscription
   * unmarked so the expiring job can retry on a later run.
   */
  async function createAndSendRenewalInvoice(
    subscription: Subscription,
    chat: Chat,
    user: User,
  ): Promise<boolean> {
    try {
      let subscriptionPayment = await deps.getPendingPaymentForSubscription(
        subscription.userId,
        subscription.chatId,
      )
      if (!subscriptionPayment) {
        // Existing subscribers keep subscription.price when the owner changes chat.price for
        // new joiners. Invoice amount, payment row, caption, and settle payout all use that
        // locked price — never the current chat list price.
        const invoice = await deps.masterWallet.createInvoice(
          subscription.price,
          deps.invoiceExpirySeconds,
        )
        subscriptionPayment = await deps.createSubscriptionPayment({
          chatId: subscription.chatId,
          userId: subscription.userId,
          paymentHash: invoice.payment_hash,
          paymentRequest: invoice.bolt11,
          subscriptionType: 'monthly',
          price: subscription.price,
          kind: 'renewal',
        })
      }

      const bolt11 = subscriptionPayment.paymentRequest
      const keyboard = buildSubscriptionPaymentKeyboard(
        key => deps.translate(key, user.languageCode),
        {
          paymentId: subscriptionPayment.id,
          payWallet: true,
          payNWC: Boolean(user.nwcUrl),
        },
      )

      const rate = await deps.getBtcUsd()
      const usdSuffix = rate === null ? '' : formatUsdSuffix(satsToUsd(subscription.price, rate))

      const buffer = await QRCode.toBuffer(bolt11)
      const inputFile = new InputFile(buffer)
      const delivered = await deps.notifier.sendPhoto(user.id, inputFile, {
        caption: deps.translate('subscription-renewal.need-payment', user.languageCode, {
          title: chat.title,
          price: subscription.price,
          usdSuffix,
          invoice: bolt11,
        }),
        show_caption_above_media: true,
        reply_markup: keyboard,
      })
      if (!delivered) {
        deps.log.error(
          {subscriptionId: subscription.id, userId: user.id, paymentId: subscriptionPayment.id},
          'Renewal reminder photo was not delivered',
        )
        return false
      }
      return true
    } catch (error) {
      deps.log.error(
        {error, subscriptionId: subscription.id, userId: user.id},
        'Error in createAndSendRenewalInvoice',
      )
      return false
    }
  }

  return {attemptAutoRenewal, createAndSendRenewalInvoice}
}
