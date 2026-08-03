import {configureBot} from '@bootstrap/configure-bot.js'
import type {AppContainer} from '@bootstrap/container.js'
import {startServer} from '@http/app.js'
import {deleteWebhook} from '@infra/telegram/webhook.js'
import {createScheduler, defaultJobDefinitions, type Scheduler} from '@jobs/scheduler.js'
import {registerHandlers} from '@telegram/composition.js'

export type RunningApp = {
  container: AppContainer
  scheduler: Scheduler
  start: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Wire handlers, HTTP server and scheduler on top of a filled container.
 */
export function createApp(container: AppContainer): RunningApp {
  const {config, log, bot} = container

  registerHandlers(bot)

  const scheduler = createScheduler(defaultJobDefinitions(), log)

  let server: ReturnType<typeof startServer> | undefined

  return {
    container,
    scheduler,

    async start() {
      await new Promise<void>((resolve, reject) => {
        // BotContext is a Context flavor; cast for the HTTP layer which is flavor-agnostic.
        server = startServer({bot: bot as never, config, log}, () => {
          bot
            .init()
            .then(async () => {
              if (config.CONFIGURE_BOT) {
                await configureBot({bot: bot as never, config, log})
              }
              scheduler.start()
              resolve()
            })
            .catch((error: unknown) => {
              log.error({error}, 'Failed to configure bot')
              reject(error)
            })
        })
      })
    },

    async stop() {
      // Drain in-flight cron ticks before tearing down HTTP / webhooks so a
      // mid-settle payout is not force-killed mid-flight.
      await scheduler.stop({drainTimeoutMs: 10_000})

      await deleteWebhook(bot as never)

      if (server) {
        await server.stop()
        log.info('Server closed')
      }
    },
  }
}
