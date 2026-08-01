/**
 * Platform fee for a subscription payment in sats.
 * Matches historical behavior: Math.ceil(sats * feePercent).
 */
export function computeSubscriptionFee(sats: number, feePercent: number): number {
  return Math.ceil(sats * feePercent)
}
