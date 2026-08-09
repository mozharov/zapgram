import {describe, expect, test} from 'bun:test'
import {
  advanceMonthlyNextAt,
  clampDonationPercent,
  computeDonationSats,
  isValidDonationAmountSats,
  MONTHLY_DONATION_PERIOD_MS,
  shouldApplyDonation,
} from './donation.js'

describe('clampDonationPercent', () => {
  test('clamps to 0–100 integers', () => {
    expect(clampDonationPercent(5)).toBe(5)
    expect(clampDonationPercent(0)).toBe(0)
    expect(clampDonationPercent(100)).toBe(100)
    expect(clampDonationPercent(-3)).toBe(0)
    expect(clampDonationPercent(150)).toBe(100)
    expect(clampDonationPercent(5.9)).toBe(5)
    expect(clampDonationPercent(Number.NaN)).toBe(0)
  })
})

describe('computeDonationSats', () => {
  test('rounds up percent of base amount', () => {
    expect(computeDonationSats(100, 5)).toBe(5)
    expect(computeDonationSats(21, 5)).toBe(2)
    expect(computeDonationSats(19, 5)).toBe(1)
    expect(computeDonationSats(1000, 0)).toBe(0)
    expect(computeDonationSats(0, 5)).toBe(0)
    expect(computeDonationSats(1, 100)).toBe(1)
  })
})

describe('shouldApplyDonation', () => {
  test('tips scope only matches tip payments', () => {
    expect(shouldApplyDonation('tips', 'tip')).toBe(true)
    expect(shouldApplyDonation('tips', 'invoice')).toBe(false)
  })

  test('all scope matches tip and invoice', () => {
    expect(shouldApplyDonation('all', 'tip')).toBe(true)
    expect(shouldApplyDonation('all', 'invoice')).toBe(true)
  })
})

describe('advanceMonthlyNextAt', () => {
  test('adds 30 days from max(from, now)', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const now = new Date('2026-01-01T12:00:00.000Z')
    const next = advanceMonthlyNextAt(from, now)
    expect(next.getTime()).toBe(now.getTime() + MONTHLY_DONATION_PERIOD_MS)
  })

  test('uses from when it is in the future relative to now', () => {
    const from = new Date('2026-02-01T00:00:00.000Z')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const next = advanceMonthlyNextAt(from, now)
    expect(next.getTime()).toBe(from.getTime() + MONTHLY_DONATION_PERIOD_MS)
  })
})

describe('isValidDonationAmountSats', () => {
  test('accepts integers in range', () => {
    expect(isValidDonationAmountSats(1)).toBe(true)
    expect(isValidDonationAmountSats(100_000)).toBe(true)
    expect(isValidDonationAmountSats(0)).toBe(false)
    expect(isValidDonationAmountSats(1.5)).toBe(false)
    expect(isValidDonationAmountSats(100_000_001)).toBe(false)
  })
})
