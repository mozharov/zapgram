/**
 * Shape check for a pasted Lightning payment request.
 *
 * The whole trimmed message must be the request. A sentence that merely mentions
 * `lnbc…` is left for the step that asked for something else. Checksums are not
 * verified: the existing pay-invoice flow decodes a bolt11 and rejects a bad one.
 * No new payment path lives here.
 */

const LIGHTNING_SCHEME = /^(?:lightning:\/\/|lightning:)/i
const LNURL_HTTP_SCHEME = /^(?:lnurlp|lnurlw):\/\//i
/** Mainnet only. `lnbcrt` (regtest) also starts with `lnbc` and must not match. */
const BOLT11 = /^lnbc(?!rt)[0-9a-z]+$/i
const LNURL = /^lnurl[0-9a-z]+$/i
/**
 * LUD-16: `<username>@<domainname>`. The username is any non-empty run of
 * `a-z 0-9 _ . -`, plus optional `+tag`s. The domain needs no dot.
 * A leading `@` is a Telegram username, not an address. LUD-16 has no port.
 */
const LN_ADDRESS_NAME = '[a-z0-9._-]+'
const LN_ADDRESS_HOST =
  '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*'
const LIGHTNING_ADDRESS = new RegExp(
  `^${LN_ADDRESS_NAME}(?:\\+${LN_ADDRESS_NAME})*@${LN_ADDRESS_HOST}$`,
  'i',
)

export type PaymentRequestKind = 'bolt11' | 'lightning-address' | 'lnurl'

export type PaymentRequest = {
  kind: PaymentRequestKind
  /** Lowercased form. Bolt11 and LNURL decoders expect a single case. */
  value: string
}

/**
 * BOLT11, Lightning address, or LNURL. Accepts a `lightning:` / `lightning://`
 * prefix, LUD-17 `lnurlp://` and `lnurlw://`, a BIP21 `lightning` parameter, and
 * whitespace around the whole message.
 */
export function recognizePaymentRequest(text: string): PaymentRequest | null {
  const trimmed = text.trim()
  const fromBip21 = bip21Lightning(trimmed)
  const raw = (fromBip21 ?? trimmed).trim()
  if (LNURL_HTTP_SCHEME.test(raw)) return {kind: 'lnurl', value: raw.toLowerCase()}

  const stripped = raw.replace(LIGHTNING_SCHEME, '').trim()
  if (!stripped || /\s/.test(stripped)) return null
  if (LNURL_HTTP_SCHEME.test(stripped)) return {kind: 'lnurl', value: stripped.toLowerCase()}

  if (BOLT11.test(stripped)) return {kind: 'bolt11', value: stripped.toLowerCase()}
  if (LNURL.test(stripped)) return {kind: 'lnurl', value: stripped.toLowerCase()}
  if (LIGHTNING_ADDRESS.test(stripped)) {
    return {kind: 'lightning-address', value: stripped.toLowerCase()}
  }
  return null
}

/** `bitcoin:...?lightning=<invoice>`. The parameter is the payment request. */
function bip21Lightning(text: string): string | null {
  if (!/^bitcoin:/i.test(text)) return null
  const query = text.indexOf('?')
  if (query < 0) return null
  return new URLSearchParams(text.slice(query + 1)).get('lightning')
}
