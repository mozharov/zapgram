import {CronJob} from 'cron'
import {logger} from '../../lib/logger.js'
import {
  countSubscriptionPayments,
  deleteSubscriptionPayment,
  getSubscriptionPayments,
} from '../../models/subscription-payment.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import type {SubscriptionPayment} from '../../lib/database/types.js'
import {
  createSubscription,
  getSubscriptionByUserAndChat,
  updateSubscription,
} from '../../models/subscriptions.js'
import {bot} from '../../bot/bot.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {getChat} from '../../models/chat.js'
import {config} from '../../config.js'

export const checkSubscriptionPaymentsJob = CronJob.from({
  cronTime: '0 */2 * * * *',
  onTick: checkSubscriptionPayments,
  runOnInit: true,
  waitForCompletion: true,
})

const BATCH_SIZE = 10
async function checkSubscriptionPayments() {
  const total = await countSubscriptionPayments()
  logger.info(`Found ${total} pending subcription payments.`)
  if (total === 0) return

  let processed = 0
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const payments = await getSubscriptionPayments(BATCH_SIZE, offset)
    if (payments.length === 0) break

    logger.info(`Processing batch of ${payments.length} subscription payments.`)

    for (const payment of payments) {
      const data = await lnbitsMasterWallet.lookupPayment(payment.paymentHash)
      if (data.paid) {
        await completeSubscriptionPayment(payment)
      } else if (data.details.expiry < new Date()) {
        logger.info({paymentHash: payment.paymentHash}, 'Subscription payment expired.')
        await deleteSubscriptionPayment(payment.id)
      }
    }

    processed += payments.length
  }

  logger.info(`Finished processing ${processed} subscription payments.`)
}

const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000
async function completeSubscriptionPayment(payment: SubscriptionPayment) {
  logger.info({paymentHash: payment.paymentHash}, 'Subscription payment successful.')
  const subscription = await getSubscriptionByUserAndChat(payment.userId, payment.chatId)
  if (subscription) {
    const endsAt =
      payment.subscriptionType === 'one_time'
        ? null
        : subscription.endsAt && subscription.endsAt > new Date()
          ? new Date(subscription.endsAt.getTime() + ONE_MONTH_IN_MS)
          : new Date(Date.now() + ONE_MONTH_IN_MS)
    await updateSubscription(subscription.id, {
      price: payment.price,
      endsAt,
    })
  } else {
    await createSubscription({
      userId: payment.userId,
      chatId: payment.chatId,
      price: payment.price,
      endsAt:
        payment.subscriptionType === 'one_time' ? null : new Date(Date.now() + ONE_MONTH_IN_MS),
    })
  }
  await deleteSubscriptionPayment(payment.id)

  await bot.api.approveChatJoinRequest(payment.chatId, payment.userId).catch((error: unknown) => {
    logger.error({error}, 'Error while approving chat join request.')
  })
  const chat = await getChat({id: payment.chatId})
  const ownerWallet = await getUserWallet(chat!.ownerId)

  const fee = Math.ceil(payment.price * config.SUBSCRIPTION_FEE_PERCENT)
  const invoice = await ownerWallet.createInvoice({sats: payment.price - fee})
  await lnbitsMasterWallet.payInvoice(invoice.bolt11)

  if (fee > 0) {
    const feeInvoice = await lnbitsMasterWallet.createFeeCollectionInvoice(fee)
    await lnbitsMasterWallet.payInvoice(feeInvoice.bolt11)
  }
  // TODO: notify chat owner about the purchase
  // TODO: notify user about successful purchase
}
