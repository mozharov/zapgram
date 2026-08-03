import path from 'node:path'
import {normalizeTelegramLanguageCode, resolveAppLocale} from '@core/i18n/locale.js'
import {I18n, type TranslationVariables} from '@grammyjs/i18n'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'

const directory = path.resolve(import.meta.dirname, './locales')
export const i18n = new I18n<BotContext>({
  defaultLocale: 'en',
  directory,
  useSession: false,
  localeNegotiator: async ctx => {
    const telegramLanguageCode = normalizeTelegramLanguageCode(ctx.from?.language_code)
    if (telegramLanguageCode) return resolveAppLocale({telegramLanguageCode})

    const storedLanguageCode =
      ctx.user?.languageCode ??
      (ctx.from ? (await getRuntime().users.findById(ctx.from.id))?.languageCode : undefined)
    return resolveAppLocale({
      telegramLanguageCode,
      storedLanguageCode,
    })
  },
})

export function translate(key: string, language = 'en', context?: TranslationVariables): string {
  const locale = resolveAppLocale({storedLanguageCode: language})
  return sanitize(i18n.t(locale, key, context))
}

export function sanitize(text: string): string {
  return text.replace(/[\u2068\u2069]/g, '')
}
