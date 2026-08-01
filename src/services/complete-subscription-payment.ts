import {bot} from '../bot/bot.js'
import {translate} from '../bot/lib/i18n.js'
import type {SubscriptionPayment} from '../lib/database/types.js'
import {logger} from '../lib/logger.js'
import {getChatOrThrow} from '../models/chat.js'
import {grantSubscriptionAccess} from '../models/subscription-access.js'
import {
  deleteSubscriptionPayment,
  MAX_SETTLE_ATTEMPTS,
  recordSettleAttempt,
} from '../models/subscription-payment.js'
import {getUserOrThrow} from '../models/user.js'
import {distributeSubscriptionPaymentOnce} from './subscription-payment.js'

/**
 * `settled` — the payment row is gone, nothing left to do.
 * `kept` — the row still exists and the next cron tick should retry it.
 */
export type CompleteSubscriptionPaymentResult = 'settled' | 'kept'

/**
 * Settle a paid subscription invoice, bounding how many times we retry a payment that keeps failing.
 *
 * The attempt is recorded *before* the work, not after, so a payment that reliably kills the process
 * still burns through its budget instead of retrying forever. Once the budget is gone the cron stops
 * selecting the row (see MAX_SETTLE_ATTEMPTS), but the row itself is never deleted.
 */
export async function completeSubscriptionPayment(
  payment: SubscriptionPayment,
): Promise<CompleteSubscriptionPaymentResult> {
  const attempt = payment.settleAttempts + 1
  await recordSettleAttempt(payment.id)

  const result = await settle(payment)

  if (result === 'kept' && attempt >= MAX_SETTLE_ATTEMPTS) {
    logger.error(
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
    logger.info({paymentHash: payment.paymentHash}, 'Subscription payment successful.')
    grantSubscriptionAccess(payment)

    await bot.api.approveChatJoinRequest(payment.chatId, payment.userId).catch((error: unknown) => {
      logger.error({error}, 'Error while approving chat join request.')
    })

    let chat: Awaited<ReturnType<typeof getChatOrThrow>>
    try {
      chat = await getChatOrThrow(payment.chatId)
    } catch (error) {
      logger.error({error, chatId: payment.chatId}, 'Failed to get chat information.')
      return 'kept'
    }

    let user: Awaited<ReturnType<typeof getUserOrThrow>>
    try {
      user = await getUserOrThrow(payment.userId)
    } catch (error) {
      logger.error({error, userId: payment.userId}, 'Failed to get user information.')
      return 'kept'
    }

    let payout: Awaited<ReturnType<typeof distributeSubscriptionPaymentOnce>>
    try {
      payout = await distributeSubscriptionPaymentOnce(payment, chat.ownerId)
    } catch (error) {
      logger.error({error}, 'Failed to distribute subscription payment.')
      return 'kept'
    }

    if (payout.status === 'pending') {
      logger.info(
        {paymentId: payment.id, payoutHash: payment.payoutHash},
        'Owner payout is still in flight at LNbits; re-checking on the next tick.',
      )
      return 'kept'
    }
    const fee = payout.fee

    await deleteSubscriptionPayment(payment.id)

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

    return 'settled'
  } catch (error) {
    logger.error({error, paymentHash: payment.paymentHash}, 'Error in completeSubscriptionPayment.')
    return 'kept'
  }
}
