export type AppLocale = 'en' | 'ru'

/** Return the canonical form of a Telegram IETF language tag, or nothing for unusable input. */
export function normalizeTelegramLanguageCode(
  languageCode: string | null | undefined,
): string | undefined {
  const value = languageCode?.trim()
  if (!value) return undefined

  try {
    return new Intl.Locale(value).toString()
  } catch {
    return undefined
  }
}

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
  const normalized = normalizeTelegramLanguageCode(languageCode)
  return normalized ? new Intl.Locale(normalized).language.toLowerCase() : undefined
}
