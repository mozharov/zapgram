import {describe, expect, test} from 'bun:test'
import {resolveAppLocale} from './locale.js'

describe('resolveAppLocale', () => {
  test('maps Russian Telegram tags to ru', () => {
    expect(resolveAppLocale({telegramLanguageCode: 'ru'})).toBe('ru')
    expect(resolveAppLocale({telegramLanguageCode: 'ru-RU'})).toBe('ru')
    expect(resolveAppLocale({telegramLanguageCode: 'ru-Cyrl-RU'})).toBe('ru')
    expect(resolveAppLocale({telegramLanguageCode: 'RU-ru'})).toBe('ru')
  })

  test('maps English and unsupported valid Telegram tags to en', () => {
    expect(resolveAppLocale({telegramLanguageCode: 'en'})).toBe('en')
    expect(resolveAppLocale({telegramLanguageCode: 'en-US'})).toBe('en')
    expect(resolveAppLocale({telegramLanguageCode: 'sr-Latn'})).toBe('en')
  })

  test('uses the stored Telegram tag when the update omits it', () => {
    expect(resolveAppLocale({storedLanguageCode: 'ru-RU'})).toBe('ru')
    expect(resolveAppLocale({telegramLanguageCode: '', storedLanguageCode: 'ru'})).toBe('ru')
  })

  test('uses the stored tag when the update tag is invalid', () => {
    expect(resolveAppLocale({telegramLanguageCode: 'not_a_tag', storedLanguageCode: 'ru'})).toBe(
      'ru',
    )
  })

  test('a valid update tag takes precedence over the stored tag', () => {
    expect(resolveAppLocale({telegramLanguageCode: 'de-DE', storedLanguageCode: 'ru'})).toBe('en')
  })

  test('falls back to en when neither tag is usable', () => {
    expect(resolveAppLocale({})).toBe('en')
    expect(
      resolveAppLocale({telegramLanguageCode: 'not_a_tag', storedLanguageCode: 'also_not_a_tag'}),
    ).toBe('en')
  })
})
