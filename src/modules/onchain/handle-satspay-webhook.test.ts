import {describe, expect, test} from 'bun:test'
import {extractSatsPayChargeFromWebhook} from './handle-satspay-webhook.js'

describe('extractSatsPayChargeFromWebhook', () => {
  test('parses object body', () => {
    expect(
      extractSatsPayChargeFromWebhook({
        id: 'ch-1',
        paid: true,
        amount: 1000,
        extra: '{"txids":["t1"]}',
      }),
    ).toEqual({
      id: 'ch-1',
      paid: true,
      amount: 1000,
      extra: '{"txids":["t1"]}',
    })
  })

  test('unwraps double-encoded JSON string', () => {
    const inner = JSON.stringify({id: 'ch-2', paid: true, amount: 500})
    expect(extractSatsPayChargeFromWebhook(JSON.stringify(inner))).toEqual({
      id: 'ch-2',
      paid: true,
      amount: 500,
      extra: null,
    })
  })

  test('returns null without id', () => {
    expect(extractSatsPayChargeFromWebhook({paid: true})).toBeNull()
    expect(extractSatsPayChargeFromWebhook(null)).toBeNull()
  })
})
