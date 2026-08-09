import {describe, expect, test} from 'bun:test'
import {extractTxidFromChargeExtra} from './txid.js'

describe('extractTxidFromChargeExtra', () => {
  test('reads first txid', () => {
    expect(extractTxidFromChargeExtra(JSON.stringify({txids: ['abc', 'def']}))).toBe('abc')
  })

  test('returns null for empty/invalid', () => {
    expect(extractTxidFromChargeExtra(null)).toBeNull()
    expect(extractTxidFromChargeExtra('{}')).toBeNull()
    expect(extractTxidFromChargeExtra('not-json')).toBeNull()
  })
})
