import type {Subscription} from '@infra/db/types.js'
import {logger} from '@infra/logger.js'
import {getChatOrThrow} from '@modules/chats/repository.js'
import {renewalService} from '@modules/subscriptions/renewal.js'
import {
  countSubscriptionsExpiringWithin,
  getSubscriptionsExpiringWithin,
  updateSubscription,
} from '@modules/subscriptions/repository.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {CronJob} from 'cron'

const BATCH_SIZE = 10
const MS_BEFORE_EXPIRATION = 24 * 60 * 60 * 1000 // 24 hours

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
          await processOne(subscription)
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

async function processOne(subscription: Subscription) {
  const user = await getUserOrThrow(subscription.userId)
  const chat = await getChatOrThrow(subscription.chatId)
  const renewalResult = await renewalService.attemptAutoRenewal(subscription, chat)
  logger.info({renewalResult, subscription}, 'Renewal result')

  if (renewalResult.status === 'handed_off') {
    // The subscriber paid; settle service / subscription payment cron owns the rest, notifications
    // included. Saying anything here would duplicate its messages.
    logger.info(
      {subscriptionId: subscription.id},
      'Renewal handed off to the subscription payment settle path.',
    )
  } else if (renewalResult.status === 'renewed') {
    // Notifications already sent by settle service (kind: renewal → subscription-renewal.renewed).
    // Previously this job sent subscription-renewal.success itself and duplicated settle work.
    logger.info(`Auto-renewed subscription ID: ${subscription.id}`)
  } else {
    await renewalService.createAndSendRenewalInvoice(subscription, chat, user)
    await updateSubscription(subscription.id, {notificationSent: true})
    logger.info(`Notification sent for subscription ID: ${subscription.id}`)
  }
}
