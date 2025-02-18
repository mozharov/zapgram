import './utils/websocker-polyfill.js' // required for @getalby/sdk
import {startServer} from './app.js'
import {logger} from './lib/logger.js'
import {config} from './config.js'
import {startTunnel, stopTunnel} from './lib/tunnel.js'
import {deleteWebhook, setWebhook} from './bot/webhook.js'
import {bot} from './bot/bot.js'
import {migrateDatabase} from './lib/database/database.js'
import {startCronJobs, stopCronJobs} from './cron/cron.js'
import {lnbitsMasterWallet} from './lib/lnbits/master-wallet.js'

if (config.DB_MIGRATE) migrateDatabase()
await lnbitsMasterWallet.checkStatus()

const server = startServer()
server.once('listening', () => {
  void bot.init()
  if (config.NGROK_TOKEN) void startTunnel().then(tunnelUrl => setWebhook(tunnelUrl))
  startCronJobs()
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

  if (config.NGROK_TOKEN) {
    await deleteWebhook()
    await stopTunnel()
  }

  server.close(error => {
    if (error) {
      logger.error({error}, 'Failed to close server')
      process.exit(1)
    }
    logger.info('Server closed')
    process.exit(0)
  })
}
