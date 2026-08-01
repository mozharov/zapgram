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
        await getRuntime()
          .bot.api.banChatMember(subscription.chatId, subscription.userId)
          .catch((error: unknown) => {
            getRuntime().log.error({error}, 'Error while banning user from chat.')
          })
          .then(async () => {
            // immediately unban so they can submit a new request to join the chat
            await getRuntime()
              .bot.api.unbanChatMember(subscription.chatId, subscription.userId)
              .catch((error: unknown) => {
                getRuntime().log.error({error}, 'Error while unbanning user from chat.')
              })
          })
        await deleteSubscription(subscription.id, now)
        return 'done'
      },
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in checkExpiredSubscriptions job')
  }
}
