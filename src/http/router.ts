import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import {Elysia} from 'elysia'
import type {Bot, Context} from 'grammy'
import {webhookCallback} from 'grammy'
import {createRequestLogger} from './middlewares/request-logger.js'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

export function createRouter(deps: {bot: Bot<Context>; config: AppConfig; log: LoggerWithChild}) {
  const telegramWebhook = webhookCallback(deps.bot as Bot, 'elysia', {
    secretToken: deps.config.BOT_WEBHOOK_SECRET,
    timeoutMilliseconds: 30_000,
    onTimeout(...args) {
      deps.log.error({args}, 'Telegram webhook timed out')
    },
  })

  return new Elysia({name: 'router'})
    .use(createRequestLogger(deps.log))
    .get('/', () => 'ok')
    .post('/bot', async ctx => {
      const update: unknown = ctx.body
      if (update && typeof update === 'object') {
        Object.assign(update, {reqId: ctx.reqId})
      }
      return telegramWebhook(ctx)
    })
}
