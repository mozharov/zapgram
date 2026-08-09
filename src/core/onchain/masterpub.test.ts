import {describe, expect, test} from 'bun:test'
import {isLikelyMasterpub, validateMasterpub} from './masterpub.js'

/** Even root (depth 0) keys pass the light check — LNbits decides depth. */
const DEPTH0_XPUB =
  'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'

const DEPTH3_XPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'

describe('validateMasterpub', () => {
  test('accepts bare xpub prefixes without depth checks', () => {
    expect(validateMasterpub(DEPTH0_XPUB)).toEqual({ok: true, value: DEPTH0_XPUB})
    expect(validateMasterpub(DEPTH3_XPUB)).toEqual({ok: true, value: DEPTH3_XPUB})
    expect(validateMasterpub('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAC').ok).toBe(true)
  })

  test('accepts descriptor form', () => {
    const desc = `wpkh([abcd1234/84h/0h/0h]${DEPTH0_XPUB}/0/*)`
    expect(validateMasterpub(desc)).toEqual({ok: true, value: desc})
  })

  test('strips whitespace', () => {
    expect(validateMasterpub(`  ${DEPTH3_XPUB}\n`)).toEqual({ok: true, value: DEPTH3_XPUB})
  })

  test('rejects empty and unknown prefixes', () => {
    expect(validateMasterpub('')).toEqual({ok: false, reason: 'empty'})
    expect(validateMasterpub('  ')).toEqual({ok: false, reason: 'empty'})
    expect(validateMasterpub('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toEqual({
      ok: false,
      reason: 'unknown_prefix',
    })
    expect(validateMasterpub('short')).toEqual({ok: false, reason: 'too_short'})
  })

  test('isLikelyMasterpub mirrors ok', () => {
    expect(isLikelyMasterpub(DEPTH0_XPUB)).toBe(true)
    expect(isLikelyMasterpub('nope')).toBe(false)
  })
})
