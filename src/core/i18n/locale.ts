export type AppLocale = 'en' | 'ru'

/** Resolve a Telegram IETF language tag to one of the translations ZapGram ships. */
export function resolveAppLocale(args: {
  telegramLanguageCode?: string | null
  storedLanguageCode?: string | null
}): AppLocale {
  const primaryLanguage =
    parsePrimaryLanguage(args.telegramLanguageCode) ??
    parsePrimaryLanguage(args.storedLanguageCode) ??
    'en'

  return primaryLanguage === 'ru' ? 'ru' : 'en'
}

function parsePrimaryLanguage(languageCode: string | null | undefined): string | undefined {
  const value = languageCode?.trim()
  if (!value) return undefined

  try {
    return new Intl.Locale(value).language.toLowerCase()
  } catch {
    return undefined
  }
}
