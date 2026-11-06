import {lookup} from 'node:dns/promises'
import {BlockList, isIP} from 'node:net'
import {
  LnurlPayError,
  type LnurlPayFailureCode,
  lnurlInvoiceProblem,
  lnurlPayEndpoint,
  payableSatRange,
} from '@core/lightning/lnurl-pay.js'
import type {PaymentRequest} from '@core/lightning/payment-request.js'
import {isValidAmount, type LnUrlRawData, parseLnUrlPayResponse} from '@getalby/lightning-tools'

/**
 * How long a recipient may stay silent before we stop and do not pay.
 * One budget covers the metadata fetch and every redirect, and again the callback.
 */
export const LNURL_PAY_TIMEOUT_MS = 10_000

const MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 3

const blockedV4 = new BlockList()
blockedV4.addSubnet('0.0.0.0', 8, 'ipv4')
blockedV4.addSubnet('10.0.0.0', 8, 'ipv4')
blockedV4.addSubnet('100.64.0.0', 10, 'ipv4')
blockedV4.addSubnet('169.254.0.0', 16, 'ipv4')
blockedV4.addSubnet('172.16.0.0', 12, 'ipv4')
blockedV4.addSubnet('192.168.0.0', 16, 'ipv4')
blockedV4.addSubnet('224.0.0.0', 4, 'ipv4')
blockedV4.addSubnet('240.0.0.0', 4, 'ipv4')

const blockedV6 = new BlockList()
blockedV6.addAddress('::', 'ipv6')
blockedV6.addSubnet('fc00::', 7, 'ipv6')
blockedV6.addSubnet('fe80::', 10, 'ipv6')
blockedV6.addSubnet('ff00::', 8, 'ipv6')

export type LnurlPayQuote = {
  minMsat: number
  maxMsat: number
  minSats: number
  maxSats: number
  /** Raw metadata string. The description hash is SHA-256 of this, not of a re-encoding. */
  metadata: string
  description: string
  callback: string
}

/**
 * LNURL-pay metadata for a lightning address or LNURL.
 *
 * `@getalby/lightning-tools` parses the pay request (`parseLnUrlPayResponse`) and checks the
 * amount window (`isValidAmount`). The HTTP itself is ours: `LightningAddress.fetch` sends the
 * address to `api.getalby.com` unless the proxy is turned off, has no timeout, and its address
 * regex rejects `user@localhost`, `user+tag@host`, and a single-label host. LUD-16 is a direct
 * `https://host/.well-known/lnurlp/name` GET. Loopback is allowed so a local recipient works;
 * link-local, private, and metadata addresses are not.
 */
export async function fetchLnurlPay(request: PaymentRequest): Promise<LnurlPayQuote> {
  const json = await getJson(lnurlPayEndpoint(request))
  const raw = payRequestRaw(json)
  let parsed: Awaited<ReturnType<typeof parseLnUrlPayResponse>>
  try {
    parsed = await parseLnUrlPayResponse(raw)
  } catch {
    throw new LnurlPayError('bad-response')
  }
  const range = payableSatRange(parsed.min, parsed.max)
  if (!range) throw new LnurlPayError('no-whole-sat')
  return {
    minMsat: parsed.min,
    maxMsat: parsed.max,
    minSats: range.minSats,
    maxSats: range.maxSats,
    metadata: raw.metadata,
    description: parsed.description,
    callback: parsed.callback,
  }
}

/**
 * Ask the callback for a bolt11 of `sats` and return it only when the amount and, if present,
 * the description hash match. A mismatch, a timeout, or a bad body throws and the caller must
 * not pay. No comment is sent (`commentAllowed` is ignored).
 */
export async function requestLnurlInvoice(quote: LnurlPayQuote, sats: number): Promise<string> {
  const msat = sats * 1000
  if (
    !Number.isSafeInteger(sats) ||
    sats < quote.minSats ||
    sats > quote.maxSats ||
    !isValidAmount({amount: msat, min: quote.minMsat, max: quote.maxMsat})
  ) {
    throw new LnurlPayError('amount')
  }
  let callback: URL
  try {
    callback = new URL(quote.callback)
  } catch {
    throw new LnurlPayError('bad-response')
  }
  callback.searchParams.set('amount', String(msat))
  const json = await getJson(callback.toString())
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new LnurlPayError('bad-response')
  }
  const body = json as Record<string, unknown>
  if (body.status === 'ERROR') throw new LnurlPayError('server')
  if (typeof body.pr !== 'string' || body.pr.length === 0) throw new LnurlPayError('bad-response')
  const problem = lnurlInvoiceProblem(body.pr, sats, quote.metadata)
  if (problem) throw new LnurlPayError(problem)
  return body.pr
}

function payRequestRaw(json: unknown): LnUrlRawData {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new LnurlPayError('bad-response')
  }
  const data = json as Record<string, unknown>
  if (data.status === 'ERROR') throw new LnurlPayError('server')
  if (data.tag !== 'payRequest') throw new LnurlPayError('bad-response')
  if (typeof data.callback !== 'string' || typeof data.metadata !== 'string') {
    throw new LnurlPayError('bad-response')
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(data.metadata)
  } catch {
    throw new LnurlPayError('bad-response')
  }
  if (!Array.isArray(metadata)) throw new LnurlPayError('bad-response')
  return data as LnUrlRawData
}

async function getJson(url: string): Promise<unknown> {
  const {status, body} = await fetchText(url)
  if (status === 408 || status === 429 || status >= 500) throw new LnurlPayError('server')
  if (status < 200 || status >= 300) throw new LnurlPayError('bad-response')
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new LnurlPayError('bad-response')
  }
}

async function fetchText(start: string): Promise<{status: number; body: string}> {
  const signal = AbortSignal.timeout(LNURL_PAY_TIMEOUT_MS)
  let current = start
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = await assertFetchable(current)
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        cache: 'no-store',
        headers: {accept: 'application/json', 'user-agent': 'ZapGram'},
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || hop === MAX_REDIRECTS) throw new LnurlPayError('bad-response')
        current = new URL(location, url).toString()
        continue
      }
      return {status: response.status, body: await readLimited(response)}
    }
  } catch (error) {
    if (error instanceof LnurlPayError) throw error
    if (isTimeout(error)) throw new LnurlPayError('timeout')
    throw new LnurlPayError('server')
  }
  throw new LnurlPayError('bad-response')
}

async function readLimited(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BYTES) throw new LnurlPayError('bad-response')
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (text.length > MAX_BYTES) throw new LnurlPayError('bad-response')
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new LnurlPayError('bad-response')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function assertFetchable(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LnurlPayError('bad-response')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LnurlPayError('bad-response')
  if (url.username || url.password) throw new LnurlPayError('bad-response')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new LnurlPayError('bad-response')
  if (isIP(host) !== 0) {
    if (disallowedIp(host)) throw new LnurlPayError('bad-response')
    return url
  }
  let records: {address: string}[]
  try {
    records = await lookup(host, {all: true, verbatim: true})
  } catch {
    throw new LnurlPayError('server')
  }
  if (records.length === 0 || records.some(record => disallowedIp(record.address))) {
    throw new LnurlPayError('bad-response')
  }
  return url
}

/** Loopback is allowed. Link-local, private, and other non-public addresses are not. */
function disallowedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = ipv4Of(bare)
  if (v4) {
    if (v4.startsWith('127.')) return false
    return blockedV4.check(v4, 'ipv4')
  }
  if (isIP(bare) !== 6) return true
  if (bare === '::1') return false
  return blockedV6.check(bare, 'ipv6')
}

function ipv4Of(ip: string): string | undefined {
  if (isIP(ip) === 4) return ip
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (dotted?.[1] && isIP(dotted[1]) === 4) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!hex?.[1] || !hex[2]) return undefined
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function lnurlFailureCode(error: unknown): LnurlPayFailureCode {
  return error instanceof LnurlPayError ? error.code : 'bad-response'
}
