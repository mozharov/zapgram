import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {recognizePaymentRequest} from '@core/lightning/payment-request.js'
import type {Context} from 'grammy'
import {buildUpdateProperties} from './analytics.js'
import {dmUnrecognizedTextProperties} from './handlers/unrecognized-private-message.js'
import {pastedPaymentToken} from './helpers/pasted-payment.js'
import {classifyTextKind, TEXT_KINDS, type TextKind} from './text-kind.js'
import {describeUpdate} from './update-log.js'

const BC1 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
const BOLT11 = 'lnbc1puniquebodyzz'
const LNURL = 'lnurl1dp68guniquezz'
const ADDRESS = 'satoshi.unique@pay.example'

const cases: Array<{text: string; kind: TextKind; onchain: boolean}> = [
  {text: BOLT11, kind: 'bolt11_invoice', onchain: false},
  {text: `  Lightning:${BOLT11.toUpperCase()}  `, kind: 'bolt11_invoice', onchain: false},
  {text: `lightning://${BOLT11}`, kind: 'bolt11_invoice', onchain: false},
  {
    text: `bitcoin:${BC1}?lightning=${BOLT11.toUpperCase()}`,
    kind: 'bolt11_invoice',
    onchain: true,
  },
  {text: LNURL, kind: 'lnurl', onchain: false},
  {text: `LNURLP://${LNURL.toUpperCase()}`, kind: 'lnurl', onchain: false},
  {text: 'Satoshi.Unique@Pay.Example', kind: 'lightning_address', onchain: false},
  {text: `lightning:${ADDRESS}`, kind: 'lightning_address', onchain: false},
  {
    text: 'tips+tag@abcdefghijklmnopqrstuvwxyz234567.onion',
    kind: 'lightning_address',
    onchain: false,
  },
  {text: BC1, kind: 'onchain_address', onchain: true},
  {text: `please ${BC1} thanks`, kind: 'onchain_address', onchain: true},
  {text: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', kind: 'onchain_address', onchain: true},
  {text: `bitcoin:${BC1}`, kind: 'onchain_address', onchain: true},
  {text: 'hello there friend', kind: 'other', onchain: false},
  {text: `pay ${BOLT11} please`, kind: 'other', onchain: false},
  {text: '@satoshi.unique', kind: 'other', onchain: false},
  {text: `${ADDRESS}:9735`, kind: 'other', onchain: false},
  {text: 'lnbcrt1puniquebodyzz', kind: 'other', onchain: false},
]

function ctx(text: string): Context {
  return {
    update: {update_id: 1, message: {}},
    from: {id: 7, is_bot: false, first_name: 'A'},
    chat: {id: 7, type: 'private'},
    message: {text},
  } as unknown as Context
}

function secretsOf(text: string): string[] {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const sources = [text, trimmed, lower]
  const normalized = recognizePaymentRequest(text)?.value
  if (normalized && !sources.includes(normalized)) sources.push(normalized)
  const pieces = [...sources]
  for (const source of sources) {
    for (const part of source.split(/[\s@:/?&=]+/)) {
      if (part.length >= 4) pieces.push(part)
    }
    const digest = createHash('sha256').update(source).digest('hex')
    pieces.push(digest, digest.slice(0, 32), digest.slice(0, 16))
  }
  if (normalized) {
    for (const userId of [1, 7, 42]) pieces.push(pastedPaymentToken(userId, normalized))
  }
  return [...new Set(pieces.filter(piece => piece.length >= 4))]
}

/** Fail when a payload or log binding holds the text, a fragment, a normalized form, or a hash. */
function expectNoTextOrHash(payload: unknown, text: string): void {
  const json = JSON.stringify(payload).toLowerCase()
  for (const secret of secretsOf(text)) {
    const needle = secret.toLowerCase()
    if ((TEXT_KINDS as readonly string[]).includes(needle)) continue
    if (TEXT_KINDS.some(kind => kind.includes(needle))) continue
    expect(json).not.toContain(needle)
  }
}

describe('classifyTextKind', () => {
  test('uses the shared Lightning classifier, then the shared on-chain check', () => {
    for (const {text, kind} of cases) {
      expect(classifyTextKind(text)).toBe(kind)
    }
  })

  test('returns only the label', () => {
    for (const {text, kind} of cases) {
      const label = classifyTextKind(text)
      expect(TEXT_KINDS).toContain(label)
      expect(label).toBe(kind)
      expect(typeof label).toBe('string')
    }
  })
})

describe('text kind stays out of PostHog payloads and the update log', () => {
  for (const [index, {text, kind, onchain}] of cases.entries()) {
    test(`${kind} [${index}]`, () => {
      const properties = dmUnrecognizedTextProperties(text)
      expect(properties).toEqual({
        text_length: text.length,
        looks_like_onchain: onchain,
        text_kind: kind,
      })
      expectNoTextOrHash(properties, text)

      const update = buildUpdateProperties(ctx(text))
      expect(update.text_kind).toBe(kind)
      expect(update.text_length).toBe(text.length)
      expectNoTextOrHash(update, text)

      const log = describeUpdate(ctx(text))
      expect(log.textKind).toBe(kind)
      expect(log.textLength).toBe(text.length)
      expect(log).not.toHaveProperty('text')
      expectNoTextOrHash(log, text)
    })
  }
})
