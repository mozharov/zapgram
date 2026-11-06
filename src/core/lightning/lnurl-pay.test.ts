import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {decode, encode, fromWords, toWords} from 'bech32'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {bolt11DescriptionHash, decodeLnurl} from './bech32.js'
import {LnurlPayError, lnurlInvoiceProblem, lnurlPayEndpoint, payableSatRange} from './lnurl-pay.js'

const METADATA = JSON.stringify([
  ['text/plain', 'Pay Alice'],
  ['text/identifier', 'alice@example.com'],
])

describe('decodeLnurl', () => {
  test('reads a bech32 LNURL the same way the bech32 package does', () => {
    const url = 'http://127.0.0.1:9876/pay?x=1'
    const encoded = encode('lnurl', toWords(Buffer.from(url)), 5000)
    expect(decodeLnurl(encoded)).toBe(url)
    expect(decodeLnurl(encoded.toUpperCase())).toBe(url)
    const reference = Buffer.from(fromWords(decode(encoded, 5000).words)).toString('utf8')
    expect(reference).toBe(url)
  })

  test('rejects a string that is not an LNURL', () => {
    expect(() => decodeLnurl('lnurl1dp68gurn8ghj7cts')).toThrow()
    expect(() => decodeLnurl('not-an-lnurl')).toThrow()
  })
})

describe('bolt11DescriptionHash', () => {
  test('returns the h tag and nothing when the invoice has no hash', () => {
    const hash = createHash('sha256').update(METADATA).digest('hex')
    const withHash = mintInvoice({sats: 30, description: 'Pay Alice', descriptionHash: hash})
    expect(bolt11DescriptionHash(withHash.bolt11)).toBe(hash)
    const plain = mintInvoice({sats: 30, description: 'Pay Alice'})
    expect(bolt11DescriptionHash(plain.bolt11)).toBeUndefined()
  })
})

describe('lnurlPayEndpoint', () => {
  test('builds the LUD-16 well-known URL, including hosts the address regex of the library skips', () => {
    expect(lnurlPayEndpoint({kind: 'lightning-address', value: 'alice@getalby.com'})).toBe(
      'https://getalby.com/.well-known/lnurlp/alice',
    )
    expect(lnurlPayEndpoint({kind: 'lightning-address', value: 'satoshi@localhost'})).toBe(
      'https://localhost/.well-known/lnurlp/satoshi',
    )
    expect(lnurlPayEndpoint({kind: 'lightning-address', value: 'user@myhost'})).toBe(
      'https://myhost/.well-known/lnurlp/user',
    )
    expect(
      lnurlPayEndpoint({kind: 'lightning-address', value: 'user.name+tag@sub.example.co'}),
    ).toBe('https://sub.example.co/.well-known/lnurlp/user.name+tag')
    expect(lnurlPayEndpoint({kind: 'lightning-address', value: 'a@example.onion'})).toBe(
      'https://example.onion/.well-known/lnurlp/a',
    )
  })

  test('decodes an LNURL and maps lnurlp://user@host onto the same well-known path', () => {
    const url = 'https://pay.example/lnurlp/alice'
    const encoded = encode('lnurl', toWords(Buffer.from(url)), 5000)
    expect(lnurlPayEndpoint({kind: 'lnurl', value: encoded})).toBe(url)
    expect(lnurlPayEndpoint({kind: 'lnurl', value: 'lnurlp://alice@example.com'})).toBe(
      'https://example.com/.well-known/lnurlp/alice',
    )
    expect(lnurlPayEndpoint({kind: 'lnurl', value: 'lnurlp://pay.example/path'})).toBe(
      'https://pay.example/path',
    )
    expect(() => lnurlPayEndpoint({kind: 'lnurl', value: 'lnurlw://alice@example.com'})).toThrow(
      LnurlPayError,
    )
    expect(() => lnurlPayEndpoint({kind: 'lnurl', value: 'lnurlw://pay.example/withdraw'})).toThrow(
      LnurlPayError,
    )
  })

  test('refuses a bolt11 and a broken LNURL', () => {
    expect(() => lnurlPayEndpoint({kind: 'bolt11', value: 'lnbc1'})).toThrow(LnurlPayError)
    expect(() => lnurlPayEndpoint({kind: 'lnurl', value: 'lnurl1notvalid'})).toThrow(LnurlPayError)
  })
})

describe('payableSatRange', () => {
  test('rounds the recipient window onto whole sats and drops a window that has none', () => {
    expect(payableSatRange(1_000, 5_000_000)).toEqual({minSats: 1, maxSats: 5000})
    expect(payableSatRange(1_500, 2_500)).toEqual({minSats: 2, maxSats: 2})
    expect(payableSatRange(1_500, 1_999)).toBeUndefined()
    expect(payableSatRange(0, 5_000)).toBeUndefined()
    expect(payableSatRange(1_000, 1_000 * 100_000_000 + 500)).toEqual({
      minSats: 1,
      maxSats: 100_000_000,
    })
  })
})

describe('lnurlInvoiceProblem', () => {
  const hash = createHash('sha256').update(METADATA).digest('hex')

  test('accepts the requested amount when the description hash matches the metadata', () => {
    const invoice = mintInvoice({sats: 30, description: 'Pay Alice', descriptionHash: hash})
    expect(lnurlInvoiceProblem(invoice.bolt11, 30, METADATA)).toBeUndefined()
  })

  test('accepts an invoice that has no description hash', () => {
    const invoice = mintInvoice({sats: 30, description: 'Pay Alice'})
    expect(lnurlInvoiceProblem(invoice.bolt11, 30, METADATA)).toBeUndefined()
  })

  test('refuses a different amount even when the hash matches', () => {
    const invoice = mintInvoice({sats: 31, description: 'Pay Alice', descriptionHash: hash})
    expect(lnurlInvoiceProblem(invoice.bolt11, 30, METADATA)).toBe('amount')
  })

  test('refuses a description hash that is not the metadata', () => {
    const invoice = mintInvoice({
      sats: 30,
      description: 'Pay Alice',
      descriptionHash: createHash('sha256').update('nope').digest('hex'),
    })
    expect(lnurlInvoiceProblem(invoice.bolt11, 30, METADATA)).toBe('description-hash')
  })

  test('refuses a bolt11 that does not decode', () => {
    expect(lnurlInvoiceProblem('lnbc1not-an-invoice', 30, METADATA)).toBe('bad-response')
  })
})
