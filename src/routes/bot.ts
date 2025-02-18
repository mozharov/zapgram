import Router from '@koa/router'
import {bot} from '../bot/bot.js'
import {logger} from '../lib/logger.js'
import {webhookCallback} from 'grammy'
import {config} from '../config.js'

export const botRouter = new Router()
botRouter.post(
  '/bot',
  async (ctx, next) => {
    const update: unknown = ctx.request.body
    if (update && typeof update === 'object') {
      Object.assign(update, {reqId: ctx.req.id})
    }
    await next()
  },
  webhookCallback(bot, 'koa', {
    secretToken: config.BOT_WEBHOOK_SECRET,
    timeoutMilliseconds: 30_000,
    onTimeout(...args) {
      logger.error({args}, 'Telegram webhook timed out')
    },
  }),
)
