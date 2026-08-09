import type {AppLocale} from '@core/i18n/locale.js'

/**
 * Whether a stored Telegram `language_code` maps to Russian app locale.
 * Mirrors `resolveAppLocale` primary-language rule for SQL/filter use without Intl.
 */
export function isRussianStoredLanguageCode(languageCode: string | null | undefined): boolean {
  if (!languageCode) return false
  const primary = languageCode.trim().toLowerCase().split(/[-_]/)[0]
  return primary === 'ru'
}

/** Match a stored language_code against an app locale (ru vs everyone else → en). */
export function matchesAppLocale(
  languageCode: string | null | undefined,
  locale: AppLocale,
): boolean {
  const isRu = isRussianStoredLanguageCode(languageCode)
  return locale === 'ru' ? isRu : !isRu
}
