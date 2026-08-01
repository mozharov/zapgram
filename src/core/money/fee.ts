/**
 * Platform fee for a subscription payment in sats.
 * Rounds up: Math.ceil(sats * feePercent).
 */
export function computeSubscriptionFee(sats: number, feePercent: number): number {
  return Math.ceil(sats * feePercent)
}
