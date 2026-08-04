/**
 * Public URL LNbits POSTs to when an invoice is paid.
 * Secret lives in the path — LNbits does not attach custom headers on webhooks.
 */
export function buildLnbitsPaymentWebhookUrl(host: string, secret: string): string {
  const base = host.replace(/\/$/, '')
  return `${base}/lnbits/webhook/${encodeURIComponent(secret)}`
}
