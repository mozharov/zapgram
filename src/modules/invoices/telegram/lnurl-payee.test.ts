import {describe, expect, test} from 'bun:test'
import {LNURL_DISPLAY_LIMIT, lnurlPayeeParts} from './lnurl-payee.js'

describe('lnurlPayeeParts', () => {
  test('names the address the user typed and the host that answered, not the metadata identifier', () => {
    const parts = lnurlPayeeParts({
      entered: 'alice@example.com',
      enteredKind: 'address',
      hosts: ['example.com', 'pay.example.com'],
      serviceText: 'Pay Alice',
    })
    expect(parts.entered).toBe('alice@example.com')
    expect(parts.route).toContain('example.com')
    expect(parts.route).toContain('pay.example.com')
    expect(parts.invoiceHost).toBe('pay.example.com')
    expect(parts.note).toBe('Pay Alice')
    expect(parts.note).not.toContain('identifier')
  })

  test('escapes markup and clips a long service note without keeping the tail', () => {
    const note = `A & B <b>${'x'.repeat(5000)}`
    const parts = lnurlPayeeParts({
      entered: 'ln.example',
      enteredKind: 'host',
      hosts: ['ln.example'],
      serviceText: note,
    })
    expect(parts.note).toContain('A &amp; B &lt;b&gt;')
    expect(parts.note.length).toBeLessThan(LNURL_DISPLAY_LIMIT * 5)
    expect(parts.note.endsWith('…')).toBe(true)
    expect(parts.note).not.toContain('x'.repeat(500))
    expect(parts.route).toBe('')
  })
})
