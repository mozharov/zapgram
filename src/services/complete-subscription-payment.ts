import {bot} from '../bot/bot.js'
import {translate} from '../bot/lib/i18n.js'
import type {SubscriptionPayment} from '../lib/database/types.js'
import {logger} from '../lib/logger.js'
import {computeSubscriptionEndsAt} from '../lib/subscriptions/policy.js'
import {getChatOrThrow} from '../models/chat.js'
import {deleteSubscriptionPayment} from '../models/subscription-payment.js'
import {
  createSubscription,
  getSubscriptionByUserAndChat,
  updateSubscription,
} from '../models/subscriptions.js'
import {getUserOrThrow} from '../models/user.js'
import {distributeSubscriptionPayment} from './subscription-payment.js'

/**
 * Settle a paid subscription invoice: grant access, approve join, pay owner, notify.
 * Behavior matches the previous inline cron implementation (Phase 2 extract only).
 */
export async function completeSubscriptionPayment(payment: SubscriptionPayment) {
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
