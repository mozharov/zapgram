import type {Subscription} from '@infra/db/types.js'
import {runBatch} from '@jobs/run-batch.js'
import {getChatOrThrow} from '@modules/chats/repository.js'
import {renewalService} from '@modules/subscriptions/renewal.js'
import {
  countSubscriptionsExpiringWithin,
  getSubscriptionsExpiringWithin,
  updateSubscription,
} from '@modules/subscriptions/repository.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {getRuntime} from '../../../runtime.js'

const MS_BEFORE_EXPIRATION = 24 * 60 * 60 * 1000 // 24 hours

export async function processExpiringSubscriptions(): Promise<void> {
  try {
    const now = new Date()
    const expiryThreshold = new Date(now.getTime() + MS_BEFORE_EXPIRATION)

    await runBatch({
      name: 'subscriptions expiring within 24 hours',
      log: getRuntime().log,
      count: () => countSubscriptionsExpiringWithin(expiryThreshold, now),
      fetch: (limit, offset) => getSubscriptionsExpiringWithin(expiryThreshold, now, limit, offset),
      process: async subscription => {
        await processOne(subscription)
        // notificationSent / endsAt changes remove the row from the expiring window query
        return 'done'
      },
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in processExpiringSubscriptions job')
  }
}

async function processOne(subscription: Subscription) {
  const user = await getUserOrThrow(subscription.userId)
  const chat = await getChatOrThrow(subscription.chatId)
  const renewalResult = await renewalService.attemptAutoRenewal(subscription, chat)
  getRuntime().log.info({renewalResult, subscription}, 'Renewal result')

  if (renewalResult.status === 'handed_off') {
    // Subscriber charged (or row already in flight); settle path owns completion and notifications.
    getRuntime().log.info(
      {subscriptionId: subscription.id},
      'Renewal handed off to the subscription payment settle path.',
    )
  } else if (renewalResult.status === 'renewed') {
    // Notifications already sent by settle service (kind: renewal → subscription-renewal.renewed).
    getRuntime().log.info(`Auto-renewed subscription ID: ${subscription.id}`)
  } else {
    await renewalService.createAndSendRenewalInvoice(subscription, chat, user)
    await updateSubscription(subscription.id, {notificationSent: true})
    getRuntime().log.info(`Notification sent for subscription ID: ${subscription.id}`)
  }
}
