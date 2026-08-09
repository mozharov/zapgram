import {describe, expect, test} from 'bun:test'
import {formatUsdAmount, formatUsdSuffix, satsToUsd} from './usd.js'

describe('satsToUsd', () => {
  test('converts 100_000_000 sats (1 BTC) at rate 50000 to 50000', () => {
    expect(satsToUsd(100_000_000, 50_000)).toBe(50_000)
  })

  test('converts 1000 sats at 100_000 USD/BTC to 1', () => {
    expect(satsToUsd(1000, 100_000)).toBe(1)
  })

  test('zero sats is zero', () => {
    expect(satsToUsd(0, 100_000)).toBe(0)
  })
})

describe('formatUsdAmount', () => {
  test('formats whole dollars with two decimals', () => {
    expect(formatUsdAmount(1)).toBe('1.00')
  })

  test('formats >= 0.01 with two decimals', () => {
    expect(formatUsdAmount(0.01)).toBe('0.01')
    expect(formatUsdAmount(0.954)).toBe('0.95')
  })

  test('formats sub-cent with enough digits (not 0.00)', () => {
    expect(formatUsdAmount(0.0042)).toBe('0.0042')
    expect(formatUsdAmount(0.00009)).not.toBe('0.00')
    expect(formatUsdAmount(0.00009).startsWith('0.0000')).toBe(true)
  })

  test('zero is 0.00', () => {
    expect(formatUsdAmount(0)).toBe('0.00')
  })
})

describe('formatUsdSuffix', () => {
  test('null is empty', () => {
    expect(formatUsdSuffix(null)).toBe('')
  })

  test('wraps amount', () => {
    expect(formatUsdSuffix(0.95)).toBe(' (~$0.95)')
  })
})
