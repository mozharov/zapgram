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

  test('the metadata host and the callback on that same host are not a redirect', () => {
    const parts = lnurlPayeeParts({
      entered: 'ln.example',
      enteredKind: 'host',
      hosts: ['ln.example', 'ln.example'],
      serviceText: '',
    })
    expect(parts.route).toBe('')
    expect(parts.invoiceHost).toBe('ln.example')
  })

  test('keeps a redirect back to the first host, and the invoice is that last hop', () => {
    const parts = lnurlPayeeParts({
      entered: 'alice@a.example',
      enteredKind: 'address',
      hosts: ['a.example', 'b.example', 'a.example'],
      serviceText: '',
    })
    expect(parts.route).toBe(
      '<code>a.example</code> → <code>b.example</code> → <code>a.example</code>',
    )
    expect(parts.invoiceHost).toBe('a.example')
  })

  test('a service note cannot spoof the route with a newline or bidi controls', () => {
    const parts = lnurlPayeeParts({
      entered: 'alice@a.example',
      enteredKind: 'address',
      hosts: ['a.example', 'pay.a.example'],
      serviceText: 'Invoice from trusted.com\n\u202Eevil.test\u202C   pay here',
    })
    expect(parts.invoiceHost).toBe('pay.a.example')
    expect(parts.route).toContain('a.example')
    expect(parts.route).toContain('pay.a.example')
    expect(parts.route).not.toContain('trusted.com')
    expect(parts.note).toBe('Invoice from trusted.com evil.test pay here')
    expect(parts.note).not.toMatch(/[\n\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
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
