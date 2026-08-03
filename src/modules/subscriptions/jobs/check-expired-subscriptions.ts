import {runBatch} from '@jobs/run-batch.js'
import {
  countExpiredSubscriptions,
  deleteSubscription,
  getExpiredSubscriptions,
} from '@modules/subscriptions/repository.js'
import {getRuntime} from '../../../runtime.js'

export async function checkExpiredSubscriptions(): Promise<void> {
  try {
    const now = new Date()
    await runBatch({
      name: 'expired subscriptions',
      log: getRuntime().log,
      count: () => countExpiredSubscriptions(now),
      fetch: (limit, offset) => getExpiredSubscriptions(limit, offset, now),
      process: async subscription => {
        // Kick = ban then immediate unban so they can re-request access. Delete the local row
        // only after both Telegram calls succeed — otherwise membership can diverge with no
        // row left to retry (still in chat after a failed ban, or stuck banned after unban fail).
        try {
          await getRuntime().bot.api.banChatMember(subscription.chatId, subscription.userId)
        } catch (error) {
          getRuntime().log.error({error}, 'Error while banning user from chat.')
          return 'keep'
        }
        try {
          await getRuntime().bot.api.unbanChatMember(subscription.chatId, subscription.userId)
        } catch (error) {
          getRuntime().log.error({error}, 'Error while unbanning user from chat.')
          return 'keep'
        }
        await deleteSubscription(subscription.id, now)
        return 'done'
      },
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in checkExpiredSubscriptions job')
  }
}
