import {Elysia} from 'elysia'
import {webhookCallback} from 'grammy'
import {bot} from '../bot/bot.js'
import {config} from '../config.js'
import {logger} from '../lib/logger.js'
import {requestLogger} from '../middlewares/request-logger.js'

const telegramWebhook = webhookCallback(bot, 'elysia', {
  secretToken: config.BOT_WEBHOOK_SECRET,
  timeoutMilliseconds: 30_000,
  onTimeout(...args) {
    logger.error({args}, 'Telegram webhook timed out')
  },
})

export const router = new Elysia({name: 'router'}).use(requestLogger).post('/bot', async ctx => {
  const update: unknown = ctx.body
  if (update && typeof update === 'object') {
    Object.assign(update, {reqId: ctx.reqId})
  }
  return telegramWebhook(ctx)
})
