import {describe, expect, test} from 'bun:test'
import {LNURL_DISPLAY_LIMIT, lnurlPayeeParts, lnurlRecipientHtml} from './lnurl-payee.js'

test('a pasted lnurlp path cannot break out of the HTML code tag', () => {
  const html = lnurlRecipientHtml('lnurlp://pay.example/x?<b>no</b>&amp=1')
  expect(html).not.toContain('<b>')
  expect(html).toContain('&lt;b&gt;')
  expect(html).toContain('&amp;amp=1')
})

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

test('long hosts keep their real suffix in the entered host, invoice host and route', () => {
  const prefix = `trusted.com.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(40)}`
  const first = `${prefix}.evil.test`
  const second = `${prefix}.other.org`
  expect(first.length).toBeGreaterThan(LNURL_DISPLAY_LIMIT)
  expect(first.length).toBeLessThanOrEqual(253)
  const parts = lnurlPayeeParts({
    entered: first,
    enteredKind: 'host',
    hosts: [first, second],
    serviceText: '',
  })
  expect(parts.entered).toBe(first)
  expect(parts.invoiceHost).toBe(second)
  expect(parts.route).toBe(`<code>${first}</code> → <code>${second}</code>`)
  expect(parts.entered).not.toBe(parts.invoiceHost)
})

test('long addresses and pasted payees drop the prefix and retain the actual @host', () => {
  const prefix = `trusted.com${'x'.repeat(500)}`
  const first = `${prefix}@evil.test`
  const second = `${prefix}@other.org`
  const parts = lnurlPayeeParts({
    entered: first,
    enteredKind: 'address',
    hosts: ['evil.test'],
    serviceText: '',
  })
  expect(parts.entered.startsWith('…')).toBe(true)
  expect(parts.entered.endsWith('@evil.test')).toBe(true)
  expect(parts.entered).not.toContain('trusted.com')
  expect(parts.entered.length).toBe(LNURL_DISPLAY_LIMIT)
  expect(lnurlRecipientHtml(first)).toBe(parts.entered)
  expect(lnurlRecipientHtml(first)).not.toBe(lnurlRecipientHtml(second))
})
