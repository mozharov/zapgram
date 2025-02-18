import {Composer} from 'grammy'
import {i18n as i18nMiddleware, sanitize} from '../lib/i18n.js'
import {BotContext} from '../context.js'

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
