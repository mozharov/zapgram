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

  test('rounds sub-cent amounts to one significant digit', () => {
    // 0.00181391 (wallet-style) → $0.002
    expect(formatUsdAmount(0.00181391)).toBe('0.002')
    expect(formatUsdAmount(0.0042)).toBe('0.004')
    // Carry into a full cent
    expect(formatUsdAmount(0.0099)).toBe('0.01')
    // 21 sats @ ~$153k/BTC ≈ $0.000322 → display $0.0003
    expect(formatUsdAmount(0.00032205)).toBe('0.0003')
    expect(formatUsdAmount(0.00009)).toBe('0.00009')
    expect(formatUsdAmount(0.00055)).toBe('0.0006')
    // Rounding carry into fewer leading zeros
    expect(formatUsdAmount(0.00095)).toBe('0.001')
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
    expect(formatUsdSuffix(0.95)).toBe(' ($0.95)')
  })
})
