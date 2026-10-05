/**
 * Shape check for the private-chat hint only.
 *
 * Checksums are intentionally not verified. A pasted address is never a send
 * destination, so a typo must still read as on-chain rather than as something
 * the bot might pay.
 */

/** BIP173 max is 90. Mainnet P2WPKH is 42 — shorter than that is not an address paste. */
const BECH32_ADDRESS = /^bc1[02-9ac-hj-np-z]{39,87}$/i

/** Legacy P2PKH (`1…`) and P2SH (`3…`) are 26–35 base58 characters. */
const LEGACY_ADDRESS = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/

/** BIP21. The payload is not parsed — the scheme alone means "send on-chain here". */
const BITCOIN_URI = /^bitcoin:\S+/i

/**
 * True when `text` looks like an on-chain destination: `bc1…`, `1…`, `3…`, or `bitcoin:`.
 * Lightning invoices (`lnbc…`) do not match.
 */
export function looksLikeOnchainAddress(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return trimmed.split(/\s+/).some(token => isOnchainToken(unwrap(token)))
}

function isOnchainToken(token: string): boolean {
  return BECH32_ADDRESS.test(token) || LEGACY_ADDRESS.test(token) || BITCOIN_URI.test(token)
}

/** Drop one layer of quotes or trailing punctuation people wrap around a paste. */
function unwrap(token: string): string {
  return token.replace(/^['"`(<[]+/, '').replace(/['"`)>\],.;!?]+$/, '')
}
