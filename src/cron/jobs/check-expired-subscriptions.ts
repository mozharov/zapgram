import {CronJob} from 'cron'
import {logger} from '../../lib/logger.js'
import {
  countExpiredSubscriptions,
  deleteSubscription,
  getExpiredSubscriptions,
} from '../../models/subscriptions.js'
import {bot} from '../../bot/bot.js'

export const checkExpiredSubscriptionsJob = CronJob.from({
  cronTime: '0 0 * * * *',
  onTick: checkExpiredSubscriptions,
  runOnInit: true,
  waitForCompletion: true,
})

const BATCH_SIZE = 10

async function checkExpiredSubscriptions() {
  const now = new Date()
  const total = await countExpiredSubscriptions(now)
  logger.info(`Found ${total} expired subscriptions.`)
  if (total === 0) return

  let processed = 0
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const subscriptions = await getExpiredSubscriptions(BATCH_SIZE, offset, now)
    if (subscriptions.length === 0) break

    logger.info(`Processing batch of ${subscriptions.length} expired subscriptions.`)

    for (const subscription of subscriptions) {
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
    }

    processed += subscriptions.length
  }

  logger.info(`Finished processing ${processed} expired subscriptions.`)
}
