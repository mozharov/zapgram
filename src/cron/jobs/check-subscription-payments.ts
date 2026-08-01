import {CronJob} from 'cron'
import {bot} from '../../bot/bot.js'
import {translate} from '../../bot/lib/i18n.js'
import type {SubscriptionPayment} from '../../lib/database/types.js'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {logger} from '../../lib/logger.js'
import {computeSubscriptionEndsAt} from '../../lib/subscriptions/policy.js'
import {getChatOrThrow} from '../../models/chat.js'
import {
  countSubscriptionPayments,
  deleteSubscriptionPayment,
  getSubscriptionPayments,
} from '../../models/subscription-payment.js'
import {
  createSubscription,
  getSubscriptionByUserAndChat,
  updateSubscription,
} from '../../models/subscriptions.js'
import {getUserOrThrow} from '../../models/user.js'
import {distributeSubscriptionPayment} from '../../services/subscription-payment.js'

export const checkSubscriptionPaymentsJob = CronJob.from({
  cronTime: '0 */3 * * * *',
  onTick: checkSubscriptionPayments,
  runOnInit: false,
  waitForCompletion: true,
})

const BATCH_SIZE = 10
async function checkSubscriptionPayments() {
  try {
    const total = await countSubscriptionPayments()
    logger.info(`Found ${total} pending subcription payments.`)
    if (total === 0) return

    let processed = 0
    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const payments = await getSubscriptionPayments(BATCH_SIZE, offset)
      if (payments.length === 0) break

      logger.info(`Processing batch of ${payments.length} subscription payments.`)

      for (const payment of payments) {
        try {
          const data = await lnbitsMasterWallet.lookupPayment(payment.paymentHash)
          if (data.paid) {
            await completeSubscriptionPayment(payment)
          } else if (data.details.expiry && data.details.expiry < new Date()) {
            logger.info({paymentHash: payment.paymentHash}, 'Subscription payment expired.')
            await deleteSubscriptionPayment(payment.id)
          }
        } catch (error) {
          logger.error(
            {error, paymentHash: payment.paymentHash},
            'Error processing subscription payment.',
          )
        }
      }

      processed += payments.length
    }

    logger.info(`Finished processing ${processed} subscription payments.`)
  } catch (error) {
    logger.error({error}, 'Error in checkSubscriptionPayments job.')
  }
}

async function completeSubscriptionPayment(payment: SubscriptionPayment) {
  try {
    logger.info({paymentHash: payment.paymentHash}, 'Subscription payment successful.')
    const now = new Date()
    const subscription = await getSubscriptionByUserAndChat(payment.userId, payment.chatId)
    if (subscription) {
      const endsAt = computeSubscriptionEndsAt({
        subscriptionType: payment.subscriptionType,
        existingEndsAt: subscription.endsAt,
        now,
      })
      await updateSubscription(subscription.id, {
        price: payment.price,
        endsAt,
        notificationSent: false,
      })
    } else {
      await createSubscription({
        userId: payment.userId,
        chatId: payment.chatId,
        price: payment.price,
        endsAt: computeSubscriptionEndsAt({
          subscriptionType: payment.subscriptionType,
          existingEndsAt: null,
          now,
        }),
      })
    }
    await deleteSubscriptionPayment(payment.id)

    await bot.api.approveChatJoinRequest(payment.chatId, payment.userId).catch((error: unknown) => {
      logger.error({error}, 'Error while approving chat join request.')
    })

    let chat: Awaited<ReturnType<typeof getChatOrThrow>>
    try {
      chat = await getChatOrThrow(payment.chatId)
    } catch (error) {
      logger.error({error, chatId: payment.chatId}, 'Failed to get chat information.')
      return
    }

    let fee: Awaited<ReturnType<typeof distributeSubscriptionPayment>>
    try {
      fee = await distributeSubscriptionPayment(payment.price, chat.ownerId)
    } catch (error) {
      logger.error({error}, 'Failed to distribute subscription payment.')
      return
    }

    let user: Awaited<ReturnType<typeof getUserOrThrow>>
    try {
      user = await getUserOrThrow(payment.userId)
    } catch (error) {
      logger.error({error, userId: payment.userId}, 'Failed to get user information.')
      return
    }

    await bot.api
      .sendMessage(
        payment.userId,
        translate('subscription-invoice.paid', user.languageCode, {
          title: chat.title,
          type: payment.subscriptionType,
        }),
      )
      .catch((error: unknown) => {
        logger.error({error}, 'Error while sending successful subscription payment to user.')
      })

    await bot.api
      .sendMessage(
        chat.ownerId,
        translate('new-subscription-payment', chat.owner.languageCode, {
          username: user.username ? `@${user.username}` : (user.firstName ?? user.id),
          title: chat.title,
          type: payment.subscriptionType,
          price: payment.price,
          fee,
          total: payment.price - fee,
        }),
      )
      .catch((error: unknown) => {
        logger.error({error}, 'Error while sending successful subscription payment to chat owner.')
      })
  } catch (error) {
    logger.error({error, paymentHash: payment.paymentHash}, 'Error in completeSubscriptionPayment.')
  }
}
