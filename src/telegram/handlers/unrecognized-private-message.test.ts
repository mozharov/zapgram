import {describe, expect, test} from 'bun:test'
import {translate} from '@telegram/i18n/i18n.js'
import {
  DM_UNRECOGNIZED_TEXT_EVENT,
  dmUnrecognizedTextProperties,
} from './unrecognized-private-message.js'

const BC1_42 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

describe('dmUnrecognizedTextProperties', () => {
  test('reports length and the on-chain flag without the message text', () => {
    const padded = `  ${BC1_42}\n`
    const properties = dmUnrecognizedTextProperties(padded)

    expect(DM_UNRECOGNIZED_TEXT_EVENT).toBe('dm_unrecognized_text')
    expect(properties).toEqual({text_length: padded.length, looks_like_onchain: true})
    expect(Object.keys(properties).sort()).toEqual(['looks_like_onchain', 'text_length'])
    expect(JSON.stringify(properties)).not.toContain('bc1')

    expect(dmUnrecognizedTextProperties('hello there')).toEqual({
      text_length: 'hello there'.length,
      looks_like_onchain: false,
    })
  })
})

describe('unrecognized private-text copy', () => {
  for (const language of ['en', 'ru'] as const) {
    test(`both hints resolve in ${language} and the on-chain one is more specific`, () => {
      const generic = translate('dm-unrecognized', language)
      const onchain = translate('dm-unrecognized-onchain', language)

      expect(generic).not.toContain('dm-unrecognized')
      expect(onchain).not.toContain('dm-unrecognized')
      expect(generic).not.toMatch(/on-chain/i)
      expect(onchain).toMatch(/on-chain/i)
      expect(onchain).not.toBe(generic)
    })
  }

  test('english copy names the Receive button and refuses an on-chain send destination', () => {
    expect(translate('dm-unrecognized', 'en')).toContain('Receive')
    const onchain = translate('dm-unrecognized-onchain', 'en')
    expect(onchain).toContain('on-chain address')
    expect(onchain).toContain('send destination')
    expect(onchain).toContain('Lightning invoice')
  })

  test('russian copy names Получить and refuses an on-chain send destination', () => {
    expect(translate('dm-unrecognized', 'ru')).toContain('Получить')
    const onchain = translate('dm-unrecognized-onchain', 'ru')
    expect(onchain).toContain('on-chain')
    expect(onchain).toContain('куда слать')
    expect(onchain).toContain('Lightning')
  })
})
