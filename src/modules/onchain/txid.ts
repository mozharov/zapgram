/**
 * Best-effort parse of SatsPay charge.extra (JSON string) for a payment txid.
 */
export function extractTxidFromChargeExtra(extra: string | null | undefined): string | null {
  if (!extra) return null
  try {
    const parsed = JSON.parse(extra) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const txids = (parsed as {txids?: unknown}).txids
    if (Array.isArray(txids) && typeof txids[0] === 'string' && txids[0].length > 0) {
      return txids[0]
    }
    return null
  } catch {
    return null
  }
}
