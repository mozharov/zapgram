/**
 * Light validation for admin-pasted master public keys.
 * Full derivation / network checks happen in LNbits Watch-Only.
 */

const MASTERPUB_PREFIXES = ['xpub', 'ypub', 'zpub', 'tpub', 'upub', 'vpub'] as const

export type MasterpubValidation =
  | {ok: true; value: string}
  | {ok: false; reason: 'empty' | 'too_short' | 'unknown_prefix'}

export function validateMasterpub(raw: string): MasterpubValidation {
  const value = raw.trim()
  if (!value) return {ok: false, reason: 'empty'}
  if (value.length < 20) return {ok: false, reason: 'too_short'}

  // Descriptor form (e.g. wpkh([fingerprint/84h/0h/0h]xpub…/0/*))
  if (value.includes('(') && value.includes(')')) {
    return {ok: true, value}
  }

  const lower = value.toLowerCase()
  if (!MASTERPUB_PREFIXES.some(prefix => lower.startsWith(prefix))) {
    return {ok: false, reason: 'unknown_prefix'}
  }
  return {ok: true, value}
}

export function isLikelyMasterpub(raw: string): boolean {
  return validateMasterpub(raw).ok
}
