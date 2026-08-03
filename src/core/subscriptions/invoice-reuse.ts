export const MIN_REUSABLE_INVOICE_REMAINING_MS = 60 * 60 * 1000

export type InvoiceReuseDecision =
  | {action: 'reuse'; remainingMinutes: number}
  | {
      action: 'replace'
      reason: 'expired' | 'expires_soon' | 'missing_expiry' | 'invalid_time'
    }

/** Decide whether a previously issued BOLT11 is safe to show again. */
export function decideInvoiceReuse(args: {
  expiryDate: Date | null | undefined
  now: Date
}): InvoiceReuseDecision {
  if (!args.expiryDate) return {action: 'replace', reason: 'missing_expiry'}

  const expiryMs = args.expiryDate.getTime()
  const nowMs = args.now.getTime()
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs)) {
    return {action: 'replace', reason: 'invalid_time'}
  }

  const remainingMs = expiryMs - nowMs
  if (remainingMs <= 0) return {action: 'replace', reason: 'expired'}
  if (remainingMs < MIN_REUSABLE_INVOICE_REMAINING_MS) {
    return {action: 'replace', reason: 'expires_soon'}
  }

  return {
    action: 'reuse',
    // Never tell the user that an invoice remains valid longer than it really does.
    remainingMinutes: Math.floor(remainingMs / 60_000),
  }
}
