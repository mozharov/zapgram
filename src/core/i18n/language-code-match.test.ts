import {expect, test} from 'bun:test'
import {isRussianStoredLanguageCode, matchesAppLocale} from './language-code-match.js'

test('isRussianStoredLanguageCode accepts ru and ru-* tags', () => {
  expect(isRussianStoredLanguageCode('ru')).toBe(true)
  expect(isRussianStoredLanguageCode('ru-RU')).toBe(true)
  expect(isRussianStoredLanguageCode('RU')).toBe(true)
  expect(isRussianStoredLanguageCode('ru_RU')).toBe(true)
})

test('isRussianStoredLanguageCode rejects non-Russian tags', () => {
  expect(isRussianStoredLanguageCode('en')).toBe(false)
  expect(isRussianStoredLanguageCode('en-US')).toBe(false)
  expect(isRussianStoredLanguageCode('uk')).toBe(false)
  expect(isRussianStoredLanguageCode('')).toBe(false)
  expect(isRussianStoredLanguageCode(undefined)).toBe(false)
})

test('matchesAppLocale routes non-ru to en', () => {
  expect(matchesAppLocale('ru', 'ru')).toBe(true)
  expect(matchesAppLocale('en', 'en')).toBe(true)
  expect(matchesAppLocale('de', 'en')).toBe(true)
  expect(matchesAppLocale('de', 'ru')).toBe(false)
  expect(matchesAppLocale('ru-RU', 'en')).toBe(false)
})
