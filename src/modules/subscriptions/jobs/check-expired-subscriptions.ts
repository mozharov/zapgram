import {logger} from '@infra/logger.js'
import {bot} from '@infra/telegram/bot.js'
import {runBatch} from '@jobs/run-batch.js'
import {
  countExpiredSubscriptions,
  deleteSubscription,
  getExpiredSubscriptions,
} from '@modules/subscriptions/repository.js'

export async function checkExpiredSubscriptions(): Promise<void> {
  try {
    const now = new Date()
    await runBatch({
      name: 'expired subscriptions',
      log: logger,
      count: () => countExpiredSubscriptions(now),
      fetch: (limit, offset) => getExpiredSubscriptions(limit, offset, now),
      process: async subscription => {
        await bot.api
          .banChatMember(subscription.chatId, subscription.userId)
          .catch((error: unknown) => {
            logger.error({error}, 'Error while banning user from chat.')
          })
          .then(async () => {
            // immediately unban so they can submit a new request to join the chat
            await bot.api
              .unbanChatMember(subscription.chatId, subscription.userId)
              .catch((error: unknown) => {
                logger.error({error}, 'Error while unbanning user from chat.')
              })
          })
        await deleteSubscription(subscription.id, now)
        return 'done'
      },
    })
  } catch (error) {
    logger.error({error}, 'Error in checkExpiredSubscriptions job')
  }
}
