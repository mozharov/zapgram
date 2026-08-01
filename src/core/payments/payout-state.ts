/**
 * What a payout lookup on the master wallet tells us about an owner payout we may have already sent.
 *
 * `retryable` means LNbits has no successful payment for that hash, so issuing and paying a fresh
 * invoice cannot double-spend.
 */
export type PayoutState = 'paid' | 'pending' | 'retryable'

/**
 * Maps `GET /api/v1/payments/{hash}` onto a payout decision.
 *
 * Mirrors the LNbits 1.5.6 handler, which answers `{paid: true, …}` for a settled payment,
 * `{paid: false, status: 'failed'}` for a definitively failed one, and `{paid: false}` (optionally
 * with a status) while it is still in flight. Anything in flight must NOT be paid again — it may
 * still settle. A 404 is handled by the caller: it means the master wallet never saw this hash.
 */
export function classifyPayoutLookup(result: {paid: boolean; status?: string}): PayoutState {
  if (result.paid) return 'paid'
  if (result.status === 'failed') return 'retryable'
  return 'pending'
}
