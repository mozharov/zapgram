import {describe, expect, test} from 'bun:test'
import {extractPaymentHashFromLnbitsWebhook} from './handle-payment-webhook.js'

describe('extractPaymentHashFromLnbitsWebhook', () => {
  test('reads payment_hash, camelCase, nested details, and checking_id', () => {
    expect(extractPaymentHashFromLnbitsWebhook({payment_hash: 'abc'})).toBe('abc')
    expect(extractPaymentHashFromLnbitsWebhook({paymentHash: 'def'})).toBe('def')
    expect(extractPaymentHashFromLnbitsWebhook({details: {payment_hash: 'ghi'}})).toBe('ghi')
    expect(extractPaymentHashFromLnbitsWebhook({checking_id: 'jkl'})).toBe('jkl')
    expect(extractPaymentHashFromLnbitsWebhook({})).toBeUndefined()
    expect(extractPaymentHashFromLnbitsWebhook(null)).toBeUndefined()
  })

  test('unwraps LNbits double-encoded payment.json() string body', () => {
    // LNbits: httpx post(json=payment.json()) where .json() is already a JSON string.
    // After the HTTP framework parses once, body is still a string.
    const payment = {
      checking_id: 'f4590199a364f591a919b13959bd6fea37ee7a067c55d2f30bfbedf41a445a19',
      payment_hash: 'f4590199a364f591a919b13959bd6fea37ee7a067c55d2f30bfbedf41a445a19',
      amount: 1000,
      status: 'success',
    }
    const onceParsedString = JSON.stringify(payment)
    expect(extractPaymentHashFromLnbitsWebhook(onceParsedString)).toBe(payment.payment_hash)

    // Raw wire body if the framework left it unparsed (JSON string value).
    const wireBody = JSON.stringify(onceParsedString)
    expect(extractPaymentHashFromLnbitsWebhook(wireBody)).toBe(payment.payment_hash)
  })

  test('rejects non-payment payloads', () => {
    expect(extractPaymentHashFromLnbitsWebhook('not-json')).toBeUndefined()
    expect(extractPaymentHashFromLnbitsWebhook('[]')).toBeUndefined()
    expect(extractPaymentHashFromLnbitsWebhook([])).toBeUndefined()
    expect(extractPaymentHashFromLnbitsWebhook('{"ok":true}')).toBeUndefined()
  })
})
