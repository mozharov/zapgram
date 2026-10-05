import {describe, expect, test} from 'bun:test'
import {looksLikeOnchainAddress} from './looks-like-address.js'

/** 42 characters. Same string the masterpub check rejects — it is an address, not an xpub. */
const BC1_42 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

const P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const P2SH = '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy'

describe('looksLikeOnchainAddress', () => {
  test('the 42-character bc1q example is on-chain even with a broken checksum', () => {
    expect(BC1_42).toHaveLength(42)
    expect(looksLikeOnchainAddress(BC1_42)).toBe(true)
    expect(looksLikeOnchainAddress(`bc1q${'q'.repeat(38)}`)).toBe(true)
    expect(`bc1q${'q'.repeat(38)}`).toHaveLength(42)
  })

  test('accepts bc1, legacy 1… and 3…, and bitcoin: URIs', () => {
    expect(looksLikeOnchainAddress(BC1_42.toUpperCase())).toBe(true)
    expect(looksLikeOnchainAddress(`  ${BC1_42}\n`)).toBe(true)
    expect(looksLikeOnchainAddress(`\`${BC1_42}\``)).toBe(true)
    expect(looksLikeOnchainAddress(`please ${BC1_42} thanks`)).toBe(true)
    expect(P2PKH).toHaveLength(34)
    expect(P2SH).toHaveLength(34)
    expect(looksLikeOnchainAddress(P2PKH)).toBe(true)
    expect(looksLikeOnchainAddress(P2SH)).toBe(true)
    expect(looksLikeOnchainAddress(`bitcoin:${P2PKH}?amount=0.01`)).toBe(true)
    expect(looksLikeOnchainAddress(`BITCOIN:${BC1_42.toUpperCase()}`)).toBe(true)
  })

  test('does not treat ordinary text, bolt11, or short prefixes as an address', () => {
    expect(looksLikeOnchainAddress('hello there')).toBe(false)
    expect(looksLikeOnchainAddress('')).toBe(false)
    expect(looksLikeOnchainAddress('   ')).toBe(false)
    expect(looksLikeOnchainAddress('lnbc1pabcdef')).toBe(false)
    expect(looksLikeOnchainAddress('pay lnbc1pabcdef now')).toBe(false)
    expect(looksLikeOnchainAddress('bc1q')).toBe(false)
    expect(looksLikeOnchainAddress('1')).toBe(false)
    expect(looksLikeOnchainAddress('3 sats')).toBe(false)
    expect(looksLikeOnchainAddress('3210000000000000000000000000')).toBe(false)
    expect(looksLikeOnchainAddress('bitcoin:')).toBe(false)
    expect(
      looksLikeOnchainAddress(
        'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
      ),
    ).toBe(false)
  })
})
