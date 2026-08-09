/**
 * Optional platform donation helpers (voluntary % on tips / invoice pays).
 * Distinct from SUBSCRIPTION_FEE_PERCENT (mandatory chat cut).
 */

export type DonationScope = 'tips' | 'all'
export type DonationPaymentKind = 'tip' | 'invoice'
export type DonationLedgerKind = 'percent' | 'one_shot' | 'monthly'

/** One-shot / monthly presets shown on /donate. */
export const DONATE_PRESETS_SATS = [21, 100, 1000, 10_000, 100_000] as const

/** Settings percent presets. */
export const DONATION_PERCENT_PRESETS = [0, 1, 5, 10] as const

/** Practical cap for custom one-shot / monthly amounts. */
export const DONATION_MAX_SATS = 100_000_000

/** Fixed 30-day billing period for in-bot monthly donations. */
export const MONTHLY_DONATION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000

export function clampDonationPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.trunc(percent)))
}

/**
 * Donation sats on top of a base payment amount.
 * Rounds up: Math.ceil(amountSats * percent / 100).
 */
export function computeDonationSats(amountSats: number, percent: number): number {
  const p = clampDonationPercent(percent)
  if (p <= 0 || amountSats <= 0) return 0
  return Math.ceil((amountSats * p) / 100)
}

export function shouldApplyDonation(scope: DonationScope, kind: DonationPaymentKind): boolean {
  if (scope === 'all') return kind === 'tip' || kind === 'invoice'
  return kind === 'tip'
}

/**
 * Advance monthly schedule: base = max(from, now), then + 30 days.
 * Avoids thrashing when a late charge lands after nextAt.
 */
export function advanceMonthlyNextAt(from: Date, now: Date = new Date()): Date {
  const baseMs = Math.max(from.getTime(), now.getTime())
  return new Date(baseMs + MONTHLY_DONATION_PERIOD_MS)
}

export function isValidDonationAmountSats(sats: number): boolean {
  return Number.isInteger(sats) && sats >= 1 && sats <= DONATION_MAX_SATS
}
