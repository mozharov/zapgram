import {Composer} from 'grammy'
import type {BotContext} from '../context.js'
import {i18n as i18nMiddleware, sanitize} from '../lib/i18n.js'

export const i18n = new Composer<BotContext>()
i18n.use(i18nMiddleware)
i18n.use((ctx, next) => {
  const translate = ctx.translate
  ctx.translate = (key, variables) => {
    return sanitize(translate(key, variables))
  }
  ctx.t = ctx.translate
  return next()
})
