/**
 * Public URL SatsPay POSTs to when a charge is paid (or balance-checked to paid).
 * Secret lives in the path — same pattern as the LNbits payment webhook.
 *
 * Ops: set SatsPay admin `webhook_method` to POST (extension default is GET for WordPress).
 */
export function buildSatsPayWebhookUrl(host: string, secret: string): string {
  const base = normalizeOrigin(host)
  return `${base}/satspay/webhook/${encodeURIComponent(secret)}`
}

function normalizeOrigin(host: string): string {
  const trimmed = host.trim().replace(/\/$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
