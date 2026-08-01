import {computeSubscriptionEndsAt} from '@core/subscriptions/policy.js'
import {CronJob} from 'cron'
import {InlineKeyboard} from 'grammy'
import {InputFile} from 'grammy/types'
import QRCode from 'qrcode'
import {bot} from '../../bot/bot.js'
import {translate} from '../../bot/lib/i18n.js'
import type {Chat, Subscription, SubscriptionPayment, User} from '../../lib/database/types.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {logger} from '../../lib/logger.js'
import {getChatOrThrow} from '../../models/chat.js'
import {grantSubscriptionAccess} from '../../models/subscription-access.js'
import {
  createSubscriptionPayment,
  deleteSubscriptionPayment,
  getPendingPaymentForSubscription,
} from '../../models/subscription-payment.js'
import {
  countSubscriptionsExpiringWithin,
  getSubscriptionsExpiringWithin,
  updateSubscription,
} from '../../models/subscriptions.js'
import {getUserOrThrow} from '../../models/user.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
// import {NostrWallet} from '../../lib/nostr-wallet.js'
import {distributeSubscriptionPaymentOnce} from '../../services/subscription-payment.js'

const BATCH_SIZE = 10
const MS_BEFORE_EXPIRATION = 24 * 60 * 60 * 1000 // 24 hours
const INVOICE_EXPIRY = 60 * 60 * 24 * 1 // 1 day
// TODO: change the script logic. It should create subscriptionpayments and pay from balance/nwc. Payment verification will be handled in the subscriptionpayments check cycle.
export const processExpiringSubscriptionsJob = CronJob.from({
  cronTime: '0 30 * * * *',
  onTick: processExpiringSubscriptions,
  runOnInit: true,
  waitForCompletion: true,
})

async function processExpiringSubscriptions() {
  try {
    const now = new Date()
    const expiryThreshold = new Date(now.getTime() + MS_BEFORE_EXPIRATION)
    const total = await countSubscriptionsExpiringWithin(expiryThreshold, now)
    logger.info(`Found ${total} subscriptions expiring within 24 hours`)
    if (total === 0) return

    let processed = 0
    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const subscriptions = await getSubscriptionsExpiringWithin(
        expiryThreshold,
        now,
        BATCH_SIZE,
        offset,
      )
      if (subscriptions.length === 0) break

      logger.info(
        `Processing batch of ${subscriptions.length} subscriptions expiring within 24 hours`,
      )

      for (const subscription of subscriptions) {
        try {
          const user = await getUserOrThrow(subscription.userId)
          const chat = await getChatOrThrow(subscription.chatId)
          const renewalResult = await attemptAutoRenewal(subscription, chat)
          logger.info({renewalResult, subscription}, 'Renewal result')

          if (renewalResult.status === 'handed_off') {
            // The subscriber paid; the subscription payment cron owns the rest, notifications
            // included. Saying anything here would duplicate its messages.
            logger.info(
              {subscriptionId: subscription.id},
              'Renewal handed off to the subscription payment cron.',
            )
          } else if (renewalResult.status === 'renewed') {
            // endsAt and notificationSent were already updated inside grantSubscriptionAccess.
            await bot.api
              .sendMessage(
                subscription.userId,
                translate('subscription-renewal.success', user.languageCode, {
                  title: chat.title,
                  expiryDate: renewalResult.newExpiryDate,
                  price: subscription.price,
                }),
              )
              .catch((error: unknown) => {
                logger.error({error}, 'Error sending renewal success message')
              })
            await bot.api
              .sendMessage(
                chat.ownerId,
                translate('new-subscription-payment', chat.owner.languageCode, {
                  username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
                  title: chat.title,
                  type: subscription.endsAt ? 'monthly' : 'one_time',
                  price: subscription.price,
                  fee: renewalResult.fee,
                  total: subscription.price - renewalResult.fee,
                }),
              )
              .catch((error: unknown) => {
                logger.error(
                  {error},
                  'Error while sending successful subscription payment to chat owner.',
                )
              })

            logger.info(`Auto-renewed subscription ID: ${subscription.id}`)
          } else {
            await createAndSendRenewalInvoice(subscription, chat, user)
            await updateSubscription(subscription.id, {notificationSent: true})
            logger.info(`Notification sent for subscription ID: ${subscription.id}`)
          }
        } catch (error) {
          logger.error(
            {error, subscriptionId: subscription.id},
            'Error processing expiring subscription',
          )
        }
      }

      processed += subscriptions.length
    }

    logger.info(`Finished processing ${processed} expiring subscriptions`)
  } catch (error) {
    logger.error({error}, 'Error in processExpiringSubscriptions job')
  }
}

/**
 * `renewed` — fully done here, this job sends the renewal messages.
 * `handed_off` — the subscriber was charged and a payment row is on disk; the subscription payment
 *   cron owns the rest. This job must stay quiet, or the user would get notified twice.
 * `failed` — nothing was collected, fall back to sending a manual invoice.
 */
type RenewalOutcome =
  | {status: 'renewed'; newExpiryDate: Date; fee: number}
  | {status: 'handed_off'}
  | {status: 'failed'}

/**
 * Charges the subscriber and settles the renewal.
 *
 * The payment row is written *before* the subscriber is charged, and is only removed once the money
 * has reached the chat owner. Anything that goes wrong in between leaves that row on disk, where the
 * subscription payment cron picks it up and finishes the job idempotently — so a failure can no
 * longer collect money from a subscriber and deliver nothing.
 */
async function attemptAutoRenewal(
  subscription: Subscription,
  // user: User,
  chat: Chat,
): Promise<RenewalOutcome> {
  let payment: SubscriptionPayment
  try {
    if (!subscription.autoRenew || !subscription.endsAt) return {status: 'failed'}

    // An existing row means an earlier attempt is still owned by the settle cron. Charging again
    // here is how a subscriber would get billed twice.
    const inFlight = await getPendingPaymentForSubscription(
      subscription.userId,
      subscription.chatId,
    )
    if (inFlight) {
      logger.info(
        {subscriptionId: subscription.id, paymentId: inFlight.id},
        'A subscription payment is already in flight; leaving this renewal to the settle cron.',
      )
      return {status: 'handed_off'}
    }

    const invoice = await lnbitsMasterWallet.createInvoice(subscription.price, INVOICE_EXPIRY)
    payment = await createSubscriptionPayment({
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
    logger.error({error, subscriptionId: subscription.id}, 'Error in attemptAutoRenewal')
    return {status: 'failed'}
  }

  // Past this point the subscriber has paid, so we never report failure — the row guarantees the
  // renewal is completed by someone, and reporting failure would invoice the user a second time.
  try {
    const now = new Date()
    const newExpiryDate = computeSubscriptionEndsAt({
      subscriptionType: payment.subscriptionType,
      existingEndsAt: subscription.endsAt,
      now,
    })
    // Extends the subscription and marks the row settled in a single transaction.
    grantSubscriptionAccess(payment, now)
    if (!newExpiryDate) return {status: 'handed_off'} // monthly always yields a date; be safe

    const payout = await distributeSubscriptionPaymentOnce(payment, chat.ownerId)
    if (payout.status === 'pending') {
      logger.info(
        {subscriptionId: subscription.id, paymentId: payment.id},
        'Renewal payout still in flight; the settle cron will finish it.',
      )
      return {status: 'handed_off'}
    }

    await deleteSubscriptionPayment(payment.id)
    return {status: 'renewed', newExpiryDate, fee: payout.fee}
  } catch (error) {
    logger.error(
      {error, subscriptionId: subscription.id, paymentId: payment.id},
      'Renewal could not be completed here; leaving the payment row for the settle cron.',
    )
    return {status: 'handed_off'}
  }
}

async function attemptPaymentFromBalance(subscription: Subscription, invoice: string) {
  try {
    logger.info(`Attempting payment from balance for subscription ${subscription.id}`)
    const wallet = await getUserWallet(subscription.userId)
    const result = await wallet.payInvoice(invoice).catch((error: unknown) => {
      logger.error({error}, 'Error paying invoice from balance')
      return null
    })
    return {success: !!result}
  } catch (error) {
    logger.error({error, subscriptionId: subscription.id}, 'Error in attemptPaymentFromBalance')
    return {success: false}
  }
}

// async function attemptPaymentFromNWC(subscription: Subscription, user: User, invoice: string) {
//   if (!user.nwcUrl) return {success: false}
//   logger.info(`Attempting payment from NWC for subscription ${subscription.id}`)
//   const nwc = new NostrWallet(user.nwcUrl)
//   const success = await nwc
//     .payInvoice(invoice, false)
//     .then(() => true)
//     .catch(() => false)
//   return {success}
// }

async function createAndSendRenewalInvoice(subscription: Subscription, chat: Chat, user: User) {
  try {
    const invoice = await lnbitsMasterWallet.createInvoice(chat.price, INVOICE_EXPIRY)
    const subscriptionPayment = await createSubscriptionPayment({
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
      text: translate('button.pay-subcription-with-wallet', user.languageCode),
    })
    if (user.nwcUrl) {
      keyboard.row({
        callback_data: `pay-sub:${subscriptionPayment.id}:nwc`,
        text: translate('button.pay-subcription-with-nwc', user.languageCode),
      })
    }

    const buffer = await QRCode.toBuffer(invoice.bolt11)
    const inputFile = new InputFile(buffer)
    await bot.api
      .sendPhoto(user.id, inputFile, {
        caption: translate('subscription-renewal.need-payment', user.languageCode, {
          title: chat.title,
          price: subscription.price,
          invoice: invoice.bolt11,
        }),
        show_caption_above_media: true,
        reply_markup: keyboard,
      })
      .catch((error: unknown) => {
        logger.error({error}, 'Error sending renewal invoice')
      })
  } catch (error) {
    logger.error(
      {error, subscriptionId: subscription.id, userId: user.id},
      'Error in createAndSendRenewalInvoice',
    )
  }
}
