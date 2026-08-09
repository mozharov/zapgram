import {describe, expect, test} from 'bun:test'
import {buildSatsPayWebhookUrl} from './satspay-webhook-url.js'

describe('buildSatsPayWebhookUrl', () => {
  test('joins host and secret with path encoding', () => {
    expect(buildSatsPayWebhookUrl('https://bot.example.com', 'sec/ret')).toBe(
      'https://bot.example.com/satspay/webhook/sec%2Fret',
    )
  })

  test('adds https when scheme is missing', () => {
    expect(buildSatsPayWebhookUrl('bot.example.com/', 'abc')).toBe(
      'https://bot.example.com/satspay/webhook/abc',
    )
  })
})
