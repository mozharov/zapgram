/**
 * Shape check for a pasted Lightning payment request.
 *
 * The whole trimmed message must be the request. A sentence that merely mentions
 * `lnbc…` is left for the step that asked for something else. Checksums are not
 * verified: the existing pay-invoice flow decodes a bolt11 and rejects a bad one.
 * No new payment path lives here.
 */

const LIGHTNING_SCHEME = /^lightning:\s*/i
const BOLT11 = /^lnbc[0-9a-z]+$/i
const LNURL = /^lnurl[0-9a-z]+$/i
/** LUD-16 internet identifier. A dot and a real TLD keep `a@b` from matching. */
const LIGHTNING_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i

export type PaymentRequestKind = 'bolt11' | 'lightning-address' | 'lnurl'

export type PaymentRequest = {
  kind: PaymentRequestKind
  /** Lowercased form. Bolt11 and LNURL decoders expect a single case. */
  value: string
}

/** BOLT11, Lightning address, or LNURL, including a `lightning:` prefix and edge whitespace. */
export function recognizePaymentRequest(text: string): PaymentRequest | null {
  const stripped = text.trim().replace(LIGHTNING_SCHEME, '')
  if (!stripped || /\s/.test(stripped)) return null

  if (BOLT11.test(stripped)) return {kind: 'bolt11', value: stripped.toLowerCase()}
  if (LNURL.test(stripped)) return {kind: 'lnurl', value: stripped.toLowerCase()}
  if (LIGHTNING_ADDRESS.test(stripped)) {
    return {kind: 'lightning-address', value: stripped.toLowerCase()}
  }
  return null
}
