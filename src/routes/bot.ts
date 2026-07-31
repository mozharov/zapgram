import Router, {type RouterMiddleware} from '@koa/router'
import {webhookCallback} from 'grammy'
import {bot} from '../bot/bot.js'
import {config} from '../config.js'
import {logger} from '../lib/logger.js'

export const botRouter = new Router()

// grammY KoaAdapter duck-type does not match @koa/router@15 Middleware generics.
const telegramWebhook = webhookCallback(bot, 'koa', {
  secretToken: config.BOT_WEBHOOK_SECRET,
  timeoutMilliseconds: 30_000,
  onTimeout(...args) {
    logger.error({args}, 'Telegram webhook timed out')
  },
}) as RouterMiddleware

botRouter.post(
  '/bot',
  async (ctx, next) => {
    const update: unknown = ctx.request.body
    if (update && typeof update === 'object') {
      Object.assign(update, {reqId: ctx.req.id})
    }
    await next()
  },
  telegramWebhook,
)
