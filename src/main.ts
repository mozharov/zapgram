import {configureBot} from '@bootstrap/configure-bot.js'
import {createConfig} from '@config'
import {startServer} from '@http/app.js'
import {migrateDatabase} from '@infra/db/client.js'
import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {bot} from '@infra/telegram/bot.js'
import {deleteWebhook, setWebhook} from '@infra/telegram/webhook.js'
import {startTunnel, stopTunnel} from '@infra/tunnel.js'
import {startCronJobs, stopCronJobs} from '@jobs/scheduler.js'
import {registerHandlers} from '@telegram/composition.js'
import type {BotContext} from '@telegram/context.js'
import type {Bot} from 'grammy'

const config = (() => {
  try {
    return createConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
})()

registerHandlers(bot as unknown as Bot<BotContext>)

if (config.DB_MIGRATE) migrateDatabase()
await lnbitsMasterWallet.checkStatus()

const app = startServer(() => {
  bot
    .init()
    .then(async () => {
      if (config.NGROK_TOKEN) {
        await startTunnel().then(url => setWebhook(bot, url, config.BOT_WEBHOOK_SECRET))
      }
      if (config.CONFIGURE_BOT) await configureBot()
      startCronJobs()
    })
    .catch((error: unknown) => {
      logger.error({error}, 'Failed to configure bot')
      process.exit(1)
    })
})

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`)
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down')
    process.exit(1)
  }, 10000)

  stopCronJobs()
  await deleteWebhook(bot)
  if (config.NGROK_TOKEN) await stopTunnel()

  try {
    await app.stop()
    logger.info('Server closed')
    process.exit(0)
  } catch (error) {
    logger.error({error}, 'Failed to close server')
    process.exit(1)
  }
}
