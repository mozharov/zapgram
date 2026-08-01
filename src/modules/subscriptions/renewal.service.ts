import type {TranslationVariables} from '@grammyjs/i18n'
import type {Chat, Subscription, SubscriptionPayment, User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {InlineKeyboard, InputFile} from 'grammy'
import QRCode from 'qrcode'
import type {CompleteSubscriptionPaymentResult} from './settle.service.js'

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
  }
  getUserWallet: (userId: number) => Promise<{
    payInvoice: (bolt11: string) => Promise<unknown>
  }>
  /**
   * Single settlement path — grant access, pay owner, notify.
   * Auto-renew no longer duplicates this logic (see TODO on the expiring-subscriptions job).
   */
  completePayment: (payment: SubscriptionPayment) => Promise<CompleteSubscriptionPaymentResult>
  notifier: Notifier
  log: AppLogger
  translate: (key: string, language?: string, context?: TranslationVariables) => string
  invoiceExpirySeconds: number
}

export type RenewalService = {
  attemptAutoRenewal: (subscription: Subscription, chat: Chat) => Promise<RenewalOutcome>
  createAndSendRenewalInvoice: (subscription: Subscription, chat: Chat, user: User) => Promise<void>
}

export function createRenewalService(deps: RenewalServiceDeps): RenewalService {
  /**
   * Charges the subscriber and hands settlement to the settle service.
   *
   * The payment row is written *before* the subscriber is charged. After a successful charge,
   * `completePayment` runs the single grant → pay owner → notify path. Anything that goes wrong
   * leaves that row on disk, where the subscription payment cron picks it up and finishes the job
   * idempotently — so a failure can no longer collect money from a subscriber and deliver nothing.
   */
  async function attemptAutoRenewal(
    subscription: Subscription,
    // user: User,
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

      const paymentResult = await attemptPaymentFromBalance(subscription, invoice.bolt11)
      // TODO: automatic payment from NWC wallet. Additional checks are needed because LNBits doesn't mark the invoice as paid immediately. May need a separate cycle for funds distribution.
      // if (!paymentResult.success) {
      //   paymentResult = await attemptPaymentFromNWC(subscription, user, invoice.bolt11)
      // }
      if (!paymentResult.success) {
        // Deliberately not deleted: "failed" here can also mean an ambiguous error on a charge that
        // did go through. The settle cron asks LNbits and either completes it or drops it at expiry.
        return {status: 'failed'}
      }
    } catch (error) {
      deps.log.error({error, subscriptionId: subscription.id}, 'Error in attemptAutoRenewal')
      return {status: 'failed'}
    }

    // Past this point the subscriber has paid, so we never report failure — the row guarantees the
    // renewal is completed by someone, and reporting failure would invoice the user a second time.
    //
    // Settlement (grant access → pay owner → notify) is owned exclusively by the settle service.
    // Previously this job duplicated that path (see historical TODO on process-expiring-subscriptions).
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

  // async function attemptPaymentFromNWC(subscription: Subscription, user: User, invoice: string) {
  //   if (!user.nwcUrl) return {success: false}
  //   deps.log.info(`Attempting payment from NWC for subscription ${subscription.id}`)
  //   const nwc = new NostrWallet(user.nwcUrl)
  //   const success = await nwc
  //     .payInvoice(invoice, false)
  //     .then(() => true)
  //     .catch(() => false)
  //   return {success}
  // }

  async function createAndSendRenewalInvoice(subscription: Subscription, chat: Chat, user: User) {
    try {
      const invoice = await deps.masterWallet.createInvoice(chat.price, deps.invoiceExpirySeconds)
      const subscriptionPayment = await deps.createSubscriptionPayment({
        chatId: subscription.chatId,
        userId: subscription.userId,
        paymentHash: invoice.payment_hash,
        paymentRequest: invoice.bolt11,
        subscriptionType: 'monthly',
        price: subscription.price,
        kind: 'renewal',
      })

      const keyboard = new InlineKeyboard().row({
        callback_data: `pay-sub:${subscriptionPayment.id}:wallet`,
        text: deps.translate('button.pay-subcription-with-wallet', user.languageCode),
      })
      if (user.nwcUrl) {
        keyboard.row({
          callback_data: `pay-sub:${subscriptionPayment.id}:nwc`,
          text: deps.translate('button.pay-subcription-with-nwc', user.languageCode),
        })
      }

      const buffer = await QRCode.toBuffer(invoice.bolt11)
      const inputFile = new InputFile(buffer)
      await deps.notifier.sendPhoto(user.id, inputFile, {
        caption: deps.translate('subscription-renewal.need-payment', user.languageCode, {
          title: chat.title,
          price: subscription.price,
          invoice: invoice.bolt11,
        }),
        show_caption_above_media: true,
        reply_markup: keyboard,
      })
    } catch (error) {
      deps.log.error(
        {error, subscriptionId: subscription.id, userId: user.id},
        'Error in createAndSendRenewalInvoice',
      )
    }
  }

  return {attemptAutoRenewal, createAndSendRenewalInvoice}
}
