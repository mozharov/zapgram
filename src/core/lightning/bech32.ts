/**
 * Bech32 (BIP-173) for LNURL and for the BOLT11 description-hash tag.
 * `bolt11` is a devDependency, and `@getalby/lightning-tools` does not expose the hash.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const MAX_LENGTH = 8192
const CHECKSUM_WORDS = 6
const BOLT11_SIGNATURE_WORDS = 104
const BOLT11_TIMESTAMP_WORDS = 7
const DESCRIPTION_HASH_TAG = 23

export function bech32Decode(value: string): {prefix: string; words: number[]} {
  if (value.length < 8 || value.length > MAX_LENGTH) throw new Error('Invalid bech32 length')
  const lowered = value.toLowerCase()
  const split = lowered.lastIndexOf('1')
  if (split < 1 || split + CHECKSUM_WORDS >= lowered.length) {
    throw new Error('Invalid bech32 separator')
  }
  const prefix = lowered.slice(0, split)
  const words: number[] = []
  for (const char of lowered.slice(split + 1)) {
    const index = CHARSET.indexOf(char)
    if (index < 0) throw new Error('Invalid bech32 character')
    words.push(index)
  }
  if (polymod(hrpExpand(prefix).concat(words)) !== 1) throw new Error('Invalid bech32 checksum')
  return {prefix, words: words.slice(0, -CHECKSUM_WORDS)}
}

/** LNURL-bech32 → the URL it encodes. Throws when the string is not an LNURL. */
export function decodeLnurl(lnurl: string): string {
  const decoded = bech32Decode(lnurl)
  if (decoded.prefix !== 'lnurl') throw new Error('Not an LNURL')
  const bytes = convertBits(decoded.words, 5, 8, false)
  return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(bytes))
}

/**
 * BOLT11 `h` tag (description hash), lowercase hex, or undefined when the invoice
 * has no such tag. Throws when the invoice is not a readable bolt11 — a caller
 * that must not pay on a bad invoice should treat that as a refusal.
 */
export function bolt11DescriptionHash(paymentRequest: string): string | undefined {
  const decoded = bech32Decode(paymentRequest)
  if (!decoded.prefix.startsWith('ln')) throw new Error('Not a bolt11 invoice')
  if (decoded.words.length < BOLT11_SIGNATURE_WORDS + BOLT11_TIMESTAMP_WORDS) {
    throw new Error('Truncated bolt11 invoice')
  }
  let rest = decoded.words.slice(
    BOLT11_TIMESTAMP_WORDS,
    decoded.words.length - BOLT11_SIGNATURE_WORDS,
  )
  let hash: string | undefined
  while (rest.length > 0) {
    if (rest.length < 3) throw new Error('Truncated bolt11 tag')
    const tag = rest[0]
    const length = (rest[1] ?? 0) * 32 + (rest[2] ?? 0)
    if (rest.length < 3 + length) throw new Error('Truncated bolt11 tag')
    const body = rest.slice(3, 3 + length)
    rest = rest.slice(3 + length)
    if (tag !== DESCRIPTION_HASH_TAG) continue
    if (hash !== undefined) throw new Error('Repeated description hash')
    const bytes = convertBits(body, 5, 8, false)
    if (bytes.length !== 32) throw new Error('Description hash is not 32 bytes')
    hash = Buffer.from(bytes).toString('hex')
  }
  return hash
}

function polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index++) {
      if ((top >> index) & 1) chk ^= GENERATOR[index] ?? 0
    }
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const values: number[] = []
  for (let index = 0; index < hrp.length; index++) {
    values.push(hrp.charCodeAt(index) >> 5)
  }
  values.push(0)
  for (let index = 0; index < hrp.length; index++) {
    values.push(hrp.charCodeAt(index) & 31)
  }
  return values
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const maxv = (1 << to) - 1
  const maxAcc = (1 << (from + to - 1)) - 1
  const result: number[] = []
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('Invalid bech32 word')
    acc = ((acc << from) | value) & maxAcc
    bits += from
    while (bits >= to) {
      bits -= to
      result.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error('Invalid bech32 padding')
  }
  return result
}
