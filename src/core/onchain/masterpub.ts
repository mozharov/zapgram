/**
 * Light shape check for admin-pasted keys before calling LNbits.
 * Depth, network, checksum, and descriptor semantics are owned by Watch-Only —
 * do not re-implement them here (risk of divergent errors).
 */

const MASTERPUB_PREFIXES = [
  'xpub',
  'ypub',
  'zpub',
  'Ypub',
  'Zpub',
  'tpub',
  'upub',
  'vpub',
  'Upub',
  'Vpub',
] as const

export type MasterpubFailReason = 'empty' | 'too_short' | 'unknown_prefix'

export type MasterpubValidation =
  | {ok: true; value: string}
  | {ok: false; reason: MasterpubFailReason}

/** Reject empty / obvious non-keys only. Real validation is LNbits Watch-Only. */
export function validateMasterpub(raw: string): MasterpubValidation {
  const value = raw.trim().replace(/\s+/g, '')
  if (!value) return {ok: false, reason: 'empty'}
  if (value.length < 20) return {ok: false, reason: 'too_short'}

  // Descriptor form (e.g. wpkh([fingerprint/84h/0h/0h]xpub…/0/*))
  if (value.includes('(') && value.includes(')')) {
    return {ok: true, value}
  }

  if (!MASTERPUB_PREFIXES.some(prefix => value.startsWith(prefix))) {
    return {ok: false, reason: 'unknown_prefix'}
  }
  return {ok: true, value}
}

export function isLikelyMasterpub(raw: string): boolean {
  return validateMasterpub(raw).ok
}
