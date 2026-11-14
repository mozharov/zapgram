import {createHash} from 'node:crypto'
import {bolt11DescriptionHash, decodeLnurl} from './bech32.js'
import {decodeInvoice} from './decode-invoice.js'
import type {PaymentRequest} from './payment-request.js'

/** Whole sats the pay screen will accept. Same ceiling as the other amount prompts. */
const MAX_SATS = 100_000_000

export const lnurlPayFailureCodes = [
  'timeout',
  'server',
  'bad-response',
  'amount',
  'description-hash',
  'no-whole-sat',
] as const

export type LnurlPayFailureCode = (typeof lnurlPayFailureCodes)[number]

/** A recipient response we will not pay. The code is the fluent selector, not a URL or body. */
export class LnurlPayError extends Error {
  readonly code: LnurlPayFailureCode

  constructor(code: LnurlPayFailureCode) {
    super(code)
    this.name = 'LnurlPayError'
    this.code = code
  }
}

/**
 * Whole sats inside the recipient's millisatoshi window, clamped to what this bot asks for.
 * Undefined when no whole sat fits (the caller must not invent an amount and must not pay).
 */
export function payableSatRange(
  minMsat: number,
  maxMsat: number,
): {minSats: number; maxSats: number} | undefined {
  if (!Number.isFinite(minMsat) || !Number.isFinite(maxMsat) || minMsat <= 0 || maxMsat < minMsat) {
    return undefined
  }
  const minSats = Math.ceil(minMsat / 1000)
  const maxSats = Math.min(MAX_SATS, Math.floor(maxMsat / 1000))
  if (!Number.isSafeInteger(minSats) || !Number.isSafeInteger(maxSats)) return undefined
  if (minSats < 1 || minSats > maxSats) return undefined
  return {minSats, maxSats}
}

/**
 * Where to GET the LNURL-pay metadata.
 * A lightning address is LUD-16 `https://host/.well-known/lnurlp/name` (no port, https).
 * An LNURL is the URL inside the bech32 string. `lnurlp://user@host` is the same well-known path.
 */
export function lnurlPayEndpoint(request: PaymentRequest): string {
  if (request.kind === 'bolt11') throw new LnurlPayError('bad-response')
  if (request.kind === 'lightning-address') return addressEndpoint(request.value)

  // LUD-17 withdraw is not a payment. Mapping `lnurlw://user@host` onto the pay
  // well-known path would charge that address.
  if (request.value.startsWith('lnurlw://')) throw new LnurlPayError('bad-response')

  let raw = request.value
  if (raw.startsWith('lnurlp://')) raw = raw.slice('lnurlp://'.length)
  if (raw.startsWith('lnurl1')) {
    try {
      return decodeLnurl(raw)
    } catch {
      throw new LnurlPayError('bad-response')
    }
  }
  if (raw.includes('@') && !raw.includes('/')) return addressEndpoint(raw)
  if (/^https?:\/\//.test(raw)) return raw
  return `https://${raw}`
}

/**
 * Why this bolt11 must not be paid, or undefined when it may.
 * The amount has to be the sats we asked for. LUD-06 requires the `h` tag to be
 * SHA-256 of the raw metadata string. A missing hash is not a payable invoice.
 * `commentAllowed` is not part of this. The metadata string itself is not rewritten.
 */
export function lnurlInvoiceProblem(
  paymentRequest: string,
  sats: number,
  metadata: string,
): LnurlPayFailureCode | undefined {
  let millisatoshi: number
  try {
    millisatoshi = decodeInvoice(paymentRequest).millisatoshi
  } catch {
    return 'bad-response'
  }
  if (!Number.isSafeInteger(sats) || sats <= 0 || millisatoshi !== sats * 1000) return 'amount'

  let hash: string | undefined
  try {
    hash = bolt11DescriptionHash(paymentRequest)
  } catch {
    return 'bad-response'
  }
  if (hash === undefined) return 'description-hash'
  const expected = createHash('sha256').update(metadata).digest('hex')
  if (hash !== expected) return 'description-hash'
  return undefined
}

function addressEndpoint(address: string): string {
  const at = address.lastIndexOf('@')
  const name = address.slice(0, at)
  const host = address.slice(at + 1)
  if (!name || !host || host.includes('/') || host.includes(':') || host.includes('@')) {
    throw new LnurlPayError('bad-response')
  }
  return `https://${host}/.well-known/lnurlp/${name}`
}
