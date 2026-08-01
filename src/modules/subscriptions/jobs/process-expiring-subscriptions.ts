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
      process: subscription => processOne(subscription),
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in processExpiringSubscriptions job')
  }
}

/**
 * Returns the runBatch verdict for this row.
 *
 * `done` means the row no longer matches the expiring-window query (endsAt moved past the
 * threshold, or notificationSent was set), so offset must NOT advance past it. `keep` means
 * the row is still in the window and offset has to step over it — without that the same row
 * is fetched forever and the job never finishes.
 */
async function processOne(subscription: Subscription): Promise<'done' | 'keep'> {
  const user = await getUserOrThrow(subscription.userId)
  const chat = await getChatOrThrow(subscription.chatId)
  const renewalResult = await renewalService.attemptAutoRenewal(subscription, chat)
  getRuntime().log.info({renewalResult, subscription}, 'Renewal result')

  if (renewalResult.status === 'handed_off') {
    // Subscriber charged (or row already in flight); settle path owns completion and notifications.
    // Nothing about the subscription changed here, so it is still inside the expiring window.
    getRuntime().log.info(
      {subscriptionId: subscription.id},
      'Renewal handed off to the subscription payment settle path.',
    )
    return 'keep'
  }
  if (renewalResult.status === 'renewed') {
    // Notifications already sent by settle service (kind: renewal → subscription-renewal.renewed).
    // endsAt was extended inside the settle transaction, so the row left the window.
    getRuntime().log.info(`Auto-renewed subscription ID: ${subscription.id}`)
    return 'done'
  }

  await renewalService.createAndSendRenewalInvoice(subscription, chat, user)
  await updateSubscription(subscription.id, {notificationSent: true})
  getRuntime().log.info(`Notification sent for subscription ID: ${subscription.id}`)
  return 'done'
}
