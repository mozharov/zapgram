import {I18n, type TranslationVariables} from '@grammyjs/i18n'
import path from 'path'

const directory = path.resolve(import.meta.dirname, '../locales')
export const i18n = new I18n({
  defaultLocale: 'en',
  directory,
  useSession: false,
})

export function translate(key: string, language = 'en', context?: TranslationVariables): string {
  return sanitize(i18n.t(language, key, context))
}

export function sanitize(text: string): string {
  return text.replace(/[\u2068\u2069]/g, '')
}
