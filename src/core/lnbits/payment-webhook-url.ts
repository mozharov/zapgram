/**
 * Public URL LNbits POSTs to when an invoice is paid.
 * Secret lives in the path — LNbits does not attach custom headers on webhooks.
 *
 * `host` may be a bare hostname; missing scheme becomes https (LNbits rejects
 * scheme-less callbacks with empty netloc / "Callback not allowed").
 */
export function buildLnbitsPaymentWebhookUrl(host: string, secret: string): string {
  const base = normalizeOrigin(host)
  return `${base}/lnbits/webhook/${encodeURIComponent(secret)}`
}

function normalizeOrigin(host: string): string {
  const trimmed = host.trim().replace(/\/$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
