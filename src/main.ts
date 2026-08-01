import {createConfig} from '@config'
import {migrateDatabase} from '@infra/db/client.js'
import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {startTunnel, stopTunnel} from '@infra/tunnel.js'
import {startServer} from './app.js'
import {bot} from './bot/bot.js'
import {deleteWebhook, setWebhook} from './bot/webhook.js'
import {startCronJobs, stopCronJobs} from './cron/cron.js'
import {configureBot} from './services/bot.js'

const config = (() => {
  try {
    return createConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
})()

if (config.DB_MIGRATE) migrateDatabase()
await lnbitsMasterWallet.checkStatus()

const app = startServer(() => {
  bot
    .init()
    .then(async () => {
      if (config.NGROK_TOKEN) await startTunnel().then(url => setWebhook(url))
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
  await deleteWebhook()
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
