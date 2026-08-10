/** Phase-0 feature request: one Telegram text message + optional tip (not escrow). */

/** Compact presets for “attach sats to this idea”. */
export const FEATURE_FUND_PRESETS_SATS = [21, 100, 1000, 10_000, 100_000] as const

/** Non-empty after trim — length is bounded by Telegram (one message). */
export function isValidFeatureRequestText(text: string): boolean {
  return text.trim().length > 0
}

/** Trim ends only; keep internal newlines / spacing for analytics. */
export function normalizeFeatureRequestText(text: string): string {
  return text.trim()
}
