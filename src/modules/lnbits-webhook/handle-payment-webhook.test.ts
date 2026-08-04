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
})
