import {describe, expect, test} from 'bun:test'
import {LNURL_DISPLAY_LIMIT} from '../lnurl-payee.js'
import {screenInvoiceDescription} from './invoice-review.js'

describe('screenInvoiceDescription', () => {
  test('a callback description cannot break the confirm screen', () => {
    const shown = screenInvoiceDescription('Pay <b>Alice</b>\n\u202Eevil.test\u202C   now & later')
    expect(shown).toBe('Pay &lt;b&gt;Alice&lt;/b&gt; evil.test now &amp; later')
    expect(shown).not.toMatch(/[\n\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
  })
})

test('long invoice memo retains its beginning and clips the end', () => {
  const prefix = 'Order 123: '
  const memo = `${prefix}${'x'.repeat(500)} memo tail`
  expect(screenInvoiceDescription(memo)).toBe(`${memo.slice(0, LNURL_DISPLAY_LIMIT - 1)}…`)
  expect(screenInvoiceDescription(memo).startsWith(prefix)).toBe(true)
  expect(screenInvoiceDescription(memo)).not.toContain('memo tail')
})
