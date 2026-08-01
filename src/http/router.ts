import {config} from '@config'
import {logger} from '@infra/logger.js'
import {bot} from '@infra/telegram/bot.js'
import {Elysia} from 'elysia'
import {webhookCallback} from 'grammy'
import {requestLogger} from './middlewares/request-logger.js'

const telegramWebhook = webhookCallback(bot, 'elysia', {
  secretToken: config.BOT_WEBHOOK_SECRET,
  timeoutMilliseconds: 30_000,
  onTimeout(...args) {
    logger.error({args}, 'Telegram webhook timed out')
  },
})

export const router = new Elysia({name: 'router'})
  .use(requestLogger)
  .get('/', () => 'ok')
  .post('/bot', async ctx => {
    const update: unknown = ctx.body
    if (update && typeof update === 'object') {
      Object.assign(update, {reqId: ctx.reqId})
    }
    return telegramWebhook(ctx)
  })
