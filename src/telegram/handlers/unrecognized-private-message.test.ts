import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {translate} from '@telegram/i18n/i18n.js'
import {UNRECOGNIZED_TEXT_CODE_POINT_LIMIT} from '@telegram/unrecognized-text.js'
import {
  captureUnrecognizedText,
  DM_UNRECOGNIZED_TEXT_EVENT,
  dmUnrecognizedTextProperties,
} from './unrecognized-private-message.js'

const BC1_42 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
const EMOJI = '😀'

describe('dmUnrecognizedTextProperties', () => {
  test('keeps the original string, including secrets, URLs, and addresses', () => {
    const samples = [
      `  ${BC1_42}\n`,
      'hello there',
      'nostr+walletconnect://deadbeef?secret=supersecret',
      'https://example.com/path?token=abc&user=alice',
      '  Lightning:LNBC1PUNIQUEBODYZZ  ',
      'Satoshi.Unique@Pay.Example',
    ]

    expect(DM_UNRECOGNIZED_TEXT_EVENT).toBe('dm_unrecognized_text')
    for (const text of samples) {
      const properties = dmUnrecognizedTextProperties(text)
      const digest = createHash('sha256').update(text).digest('hex')
      expect(properties.text).toBe(text)
      expect(properties.text_truncated).toBe(false)
      expect(properties.text_length).toBe(text.length)
      expect(properties).not.toHaveProperty('text_hash')
      const json = JSON.stringify(properties)
      expect(json).toContain(JSON.stringify(text).slice(1, -1))
      expect(json).not.toContain(digest)
      expect(json).not.toContain(digest.slice(0, 16))
    }

    expect(dmUnrecognizedTextProperties(`  ${BC1_42}\n`)).toMatchObject({
      looks_like_onchain: true,
      text_kind: 'onchain_address',
    })
    expect(dmUnrecognizedTextProperties('hello there')).toMatchObject({
      looks_like_onchain: false,
      text_kind: 'other',
    })
  })

  test('sends 4000 code points unchanged and cuts 4001 without splitting a surrogate', () => {
    expect(UNRECOGNIZED_TEXT_CODE_POINT_LIMIT).toBe(4000)

    const atLimit = `${'a'.repeat(3999)}${EMOJI}`
    expect([...atLimit].length).toBe(4000)
    expect(atLimit.length).toBe(4001)
    const kept = dmUnrecognizedTextProperties(atLimit)
    expect(kept.text).toBe(atLimit)
    expect(kept.text_truncated).toBe(false)
    expect(kept.text_length).toBe(atLimit.length)

    const onePast = `${'x'.repeat(4001)}`
    const cutBmp = dmUnrecognizedTextProperties(onePast)
    expect(cutBmp.text).toBe('x'.repeat(4000))
    expect(cutBmp.text_truncated).toBe(true)
    expect(cutBmp.text_length).toBe(4001)

    const withEmoji = `${'a'.repeat(3999)}${EMOJI}Z`
    expect([...withEmoji].length).toBe(4001)
    const cut = dmUnrecognizedTextProperties(withEmoji)
    expect(cut.text).toBe(`${'a'.repeat(3999)}${EMOJI}`)
    expect(cut.text_truncated).toBe(true)
    expect(cut.text_length).toBe(withEmoji.length)
    expect([...cut.text].length).toBe(4000)
    expect(cut.text.endsWith(EMOJI)).toBe(true)
    expect(hasLoneSurrogate(cut.text)).toBe(false)
    expect(cut.text).not.toContain('Z')
    expect(cut.looks_like_onchain).toBe(false)
  })

  test('a throwing capture does not escape, and the warning has no message text', () => {
    const text = 'https://example.com/token?secret=keep-out'
    const warnings: unknown[] = []
    const properties = dmUnrecognizedTextProperties(text)
    captureUnrecognizedText(
      {
        warn(bindings, message) {
          warnings.push({bindings, message})
        },
      },
      properties,
      {
        capture(payload: {properties?: unknown}) {
          expect(payload.properties).toBe(properties)
          throw new Error(`posthog down ${text}`)
        },
      } as never,
    )

    const logged = JSON.stringify(warnings)
    expect(logged).toContain('dm_unrecognized_text capture failed')
    expect(logged).not.toContain(text)
    expect(logged).not.toContain('keep-out')
  })
})

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

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
