import {CronJob} from 'cron'
import {logger} from '../../lib/logger.js'
import {
  getSubscriptionsExpiringWithin,
  countSubscriptionsExpiringWithin,
  updateSubscription,
} from '../../models/subscriptions.js'
import {bot} from '../../bot/bot.js'
import type {Chat, Subscription, User} from '../../lib/database/types.js'
import {translate} from '../../bot/lib/i18n.js'
import {getUserOrThrow} from '../../models/user.js'
import {getChatOrThrow} from '../../models/chat.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {createSubscriptionPayment} from '../../models/subscription-payment.js'
import {InlineKeyboard} from 'grammy'
import QRCode from 'qrcode'
import {InputFile} from 'grammy/types'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
// import {NostrWallet} from '../../lib/nostr-wallet.js'
import {distributeSubscriptionPayment} from '../../services/subscription-payment.js'

const BATCH_SIZE = 10
const MS_BEFORE_EXPIRATION = 24 * 60 * 60 * 1000 // 24 hours
const INVOICE_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export const processExpiringSubscriptionsJob = CronJob.from({
  cronTime: '0 30 * * * *',
  onTick: processExpiringSubscriptions,
  runOnInit: true,
  waitForCompletion: true,
})

async function processExpiringSubscriptions() {
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

        if (renewalResult.success) {
          await updateSubscription(subscription.id, {
            endsAt: renewalResult.newExpiryDate,
            notificationSent: false,
          })
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
}

async function attemptAutoRenewal(
  subscription: Subscription,
  // user: User,
  chat: Chat,
): Promise<{success: true; newExpiryDate: Date; fee: number} | {success: false}> {
  if (!subscription.autoRenew || !subscription.endsAt) return {success: false}

  const invoice = await lnbitsMasterWallet.createInvoice(subscription.price, INVOICE_EXPIRY)

  const paymentResult = await attemptPaymentFromBalance(subscription, invoice.bolt11)
  // TODO: automatic payment from NWC wallet. Additional checks are needed because LNBits doesn't mark the invoice as paid immediately. May need a separate cycle for funds distribution.
  // if (!paymentResult.success) {
  //   paymentResult = await attemptPaymentFromNWC(subscription, user, invoice.bolt11)
  // }
  if (!paymentResult.success) return {success: false}

  const fee = await distributeSubscriptionPayment(subscription.price, chat.ownerId)

  const newExpiryDate = new Date(subscription.endsAt)
  newExpiryDate.setDate(newExpiryDate.getDate() + 30)
  return {success: true, newExpiryDate, fee}
}

async function attemptPaymentFromBalance(subscription: Subscription, invoice: string) {
  logger.info(`Attempting payment from balance for subscription ${subscription.id}`)
  const wallet = await getUserWallet(subscription.userId)
  const result = await wallet.payInvoice(invoice).catch((error: unknown) => {
    logger.error({error}, 'Error paying invoice from balance')
    return null
  })
  return {success: !!result}
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
  const invoice = await lnbitsMasterWallet.createInvoice(chat.price, INVOICE_EXPIRY)
  const subscriptionPayment = await createSubscriptionPayment({
    chatId: subscription.chatId,
    userId: subscription.userId,
    paymentHash: invoice.payment_hash,
    paymentRequest: invoice.bolt11,
    subscriptionType: 'monthly',
    price: subscription.price,
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
}
