import {describe, expect, test} from 'bun:test'
import {screenInvoiceDescription} from './invoice-review.js'

describe('screenInvoiceDescription', () => {
  test('a callback description cannot break the confirm screen', () => {
    const shown = screenInvoiceDescription('Pay <b>Alice</b>\n\u202Eevil.test\u202C   now & later')
    expect(shown).toBe('Pay &lt;b&gt;Alice&lt;/b&gt; evil.test now &amp; later')
    expect(shown).not.toMatch(/[\n\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
  })
})
