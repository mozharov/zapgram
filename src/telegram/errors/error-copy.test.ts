import {describe, expect, test} from 'bun:test'
import type {AppErrorCode} from '@core/errors/app-error.js'
import {errorTranslationKey} from '@telegram/errors/error-copy.js'
import {translate} from '../../bot/lib/i18n.js'

const codes = Object.keys(errorTranslationKey) as AppErrorCode[]

describe('errorTranslationKey', () => {
  // Fluent renders the key path itself when a key is missing.
  for (const language of ['en', 'ru']) {
    for (const code of codes) {
      test(`${code} resolves in ${language}`, () => {
        const key = errorTranslationKey[code]
        const message = translate(key, language)
        expect(message).not.toBe(key)
        expect(message.length).toBeGreaterThan(0)
      })
    }
  }
})
