import {describe, expect, test} from 'bun:test'
import {buildLnbitsPaymentWebhookUrl} from './payment-webhook-url.js'

describe('buildLnbitsPaymentWebhookUrl', () => {
  test('joins host and secret, stripping a trailing slash on host', () => {
    expect(buildLnbitsPaymentWebhookUrl('https://bot.example', 'sec ret')).toBe(
      'https://bot.example/lnbits/webhook/sec%20ret',
    )
    expect(buildLnbitsPaymentWebhookUrl('https://bot.example/', 'abc')).toBe(
      'https://bot.example/lnbits/webhook/abc',
    )
  })
})
