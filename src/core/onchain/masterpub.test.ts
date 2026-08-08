import {describe, expect, test} from 'bun:test'
import {isLikelyMasterpub, validateMasterpub} from './masterpub.js'

describe('validateMasterpub', () => {
  test('accepts zpub/xpub/ypub prefixes', () => {
    expect(validateMasterpub('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAC').ok).toBe(true)
    expect(
      validateMasterpub(
        'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
      ).ok,
    ).toBe(true)
  })

  test('accepts descriptor form', () => {
    expect(
      validateMasterpub(
        'wpkh([abcd1234/84h/0h/0h]xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)',
      ),
    ).toEqual({
      ok: true,
      value:
        'wpkh([abcd1234/84h/0h/0h]xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz/0/*)',
    })
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
    expect(isLikelyMasterpub('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAC')).toBe(true)
    expect(isLikelyMasterpub('nope')).toBe(false)
  })
})
