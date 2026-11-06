import {lookup} from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
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
 * One budget covers DNS, the metadata fetch, every redirect, and the callback.
 */
export const LNURL_PAY_TIMEOUT_MS = 10_000

const MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 3

/** Ranges that can reach the machine, a cloud metadata service, or a tunnel. Never a pay target. */
const alwaysBlockedV4 = new BlockList()
alwaysBlockedV4.addSubnet('0.0.0.0', 8, 'ipv4')
alwaysBlockedV4.addSubnet('100.64.0.0', 10, 'ipv4')
alwaysBlockedV4.addSubnet('169.254.0.0', 16, 'ipv4')
alwaysBlockedV4.addSubnet('192.0.0.0', 24, 'ipv4')
alwaysBlockedV4.addSubnet('192.0.2.0', 24, 'ipv4')
alwaysBlockedV4.addSubnet('192.88.99.0', 24, 'ipv4')
alwaysBlockedV4.addSubnet('198.18.0.0', 15, 'ipv4')
alwaysBlockedV4.addSubnet('198.51.100.0', 24, 'ipv4')
alwaysBlockedV4.addSubnet('203.0.113.0', 24, 'ipv4')
alwaysBlockedV4.addSubnet('224.0.0.0', 4, 'ipv4')
alwaysBlockedV4.addSubnet('240.0.0.0', 4, 'ipv4')

export type LnurlPayQuote = {
  minMsat: number
  maxMsat: number
  minSats: number
  maxSats: number
  /** Raw metadata string. The description hash is SHA-256 of this exact value. */
  metadata: string
  /** Untrusted `text/plain` from the recipient. Display only — not who the user named. */
  serviceText: string
  /**
   * Hosts (with a non-default port) contacted for the metadata document, in order.
   * A redirect shows up as a longer list. This is not the metadata identifier.
   */
  metadataHosts: string[]
  callback: string
}

export type LnurlInvoice = {
  bolt11: string
  /** Hosts contacted for the callback, after the metadata chain. */
  callbackHosts: string[]
}

type ResolvedTarget = {
  url: URL
  address: string
  family: 4 | 6
  label: string
}

/**
 * LNURL-pay metadata for a lightning address or LNURL.
 *
 * `@getalby/lightning-tools` parses the pay request (`parseLnUrlPayResponse`) and checks the
 * amount window (`isValidAmount`). The HTTP itself is ours: `LightningAddress.fetch` sends the
 * address to `api.getalby.com` unless the proxy is turned off, has no timeout, and its address
 * regex rejects `user@localhost`, `user+tag@host`, and a single-label host. LUD-16 is a direct
 * `https://host/.well-known/lnurlp/name` GET.
 *
 * Loopback and RFC1918 are reachable only when `NODE_ENV` is exactly `test`. Link-local,
 * metadata, site-local, NAT64, and 6to4-to-a-private address are never a pay target. Onion
 * names are refused: there is no Tor transport, so they would be resolved on the clearnet.
 * The connection uses the address that passed that check, so a second DNS lookup cannot rebind it.
 */
export async function fetchLnurlPay(request: PaymentRequest): Promise<LnurlPayQuote> {
  const fetched = await getJson(lnurlPayEndpoint(request))
  const raw = payRequestRaw(fetched.json)
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
    serviceText: parsed.description,
    metadataHosts: fetched.hosts,
    callback: parsed.callback,
  }
}

/**
 * Ask the callback for a bolt11 of `sats` and return it only when the amount matches and the
 * description hash is SHA-256 of the metadata. Anything else throws and the caller must not pay.
 * No comment is sent (`commentAllowed` is ignored).
 */
export async function requestLnurlInvoice(
  quote: LnurlPayQuote,
  sats: number,
): Promise<LnurlInvoice> {
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
  const fetched = await getJson(callback.toString())
  const json = fetched.json
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new LnurlPayError('bad-response')
  }
  const body = json as Record<string, unknown>
  if (body.status === 'ERROR') throw new LnurlPayError('server')
  if (typeof body.pr !== 'string' || body.pr.length === 0) throw new LnurlPayError('bad-response')
  const problem = lnurlInvoiceProblem(body.pr, sats, quote.metadata)
  if (problem) throw new LnurlPayError(problem)
  return {bolt11: body.pr, callbackHosts: fetched.hosts}
}

/** True when this process may open a loopback or RFC1918 target. Only an explicit test env. */
export function lnurlLocalTargetsAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'test'
}

/** Public unicast, or (in test only) loopback and RFC1918. Mapped and tunnel addresses follow. */
export function lnurlIpAllowed(ip: string, nodeEnv: string | undefined): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = ipv4Of(bare)
  if (v4) return !disallowedV4(v4, nodeEnv)
  if (isIP(bare) !== 6) return false
  return !disallowedV6(bare, nodeEnv)
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

async function getJson(url: string): Promise<{json: unknown; hosts: string[]}> {
  const {status, body, hosts} = await fetchText(url)
  if (status === 408 || status === 429 || status >= 500) throw new LnurlPayError('server')
  if (status < 200 || status >= 300) throw new LnurlPayError('bad-response')
  try {
    return {json: JSON.parse(body) as unknown, hosts}
  } catch {
    throw new LnurlPayError('bad-response')
  }
}

async function fetchText(start: string): Promise<{status: number; body: string; hosts: string[]}> {
  const signal = AbortSignal.timeout(LNURL_PAY_TIMEOUT_MS)
  const hosts: string[] = []
  let current = start
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = await resolveTarget(current, signal)
      hosts.push(target.label)
      const response = await lnurlPinnedGet(target.url, target.address, target.family, signal)
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || hop === MAX_REDIRECTS) throw new LnurlPayError('bad-response')
        current = new URL(response.location, target.url).toString()
        continue
      }
      return {status: response.status, body: response.body, hosts}
    }
  } catch (error) {
    if (error instanceof LnurlPayError) throw error
    if (isTimeout(error)) throw new LnurlPayError('timeout')
    throw new LnurlPayError('server')
  }
  throw new LnurlPayError('bad-response')
}

async function resolveTarget(raw: string, signal: AbortSignal): Promise<ResolvedTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LnurlPayError('bad-response')
  }
  if (url.username || url.password) throw new LnurlPayError('bad-response')
  const nodeEnv = process.env.NODE_ENV
  if (!schemeAllowed(url, nodeEnv)) throw new LnurlPayError('bad-response')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new LnurlPayError('bad-response')
  const records = await addressesFor(host, signal)
  if (records.length === 0 || records.some(record => !lnurlIpAllowed(record.address, nodeEnv))) {
    throw new LnurlPayError('bad-response')
  }
  if (url.protocol === 'http:') {
    const loopback = records.every(record => isLoopback(record.address))
    if (!lnurlLocalTargetsAllowed(nodeEnv) || !loopback) throw new LnurlPayError('bad-response')
  }
  const chosen = records[0]
  if (!chosen) throw new LnurlPayError('bad-response')
  return {url, address: chosen.address, family: chosen.family, label: endpointLabel(url)}
}

async function addressesFor(
  host: string,
  signal: AbortSignal,
): Promise<{address: string; family: 4 | 6}[]> {
  if (isIP(host) !== 0) {
    return [{address: host, family: isIP(host) === 6 ? 6 : 4}]
  }
  try {
    const records = await withDeadline(lookup(host, {all: true, verbatim: true}), signal)
    return records.map(record => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    }))
  } catch (error) {
    if (error instanceof LnurlPayError) throw error
    throw new LnurlPayError('server')
  }
}

/**
 * GET `url` on `address`, the one that already passed `lnurlIpAllowed`.
 * The hostname stays on the Host header and the TLS SNI; DNS is not consulted again.
 */
export async function lnurlPinnedGet(
  url: URL,
  address: string,
  family: 4 | 6,
  signal: AbortSignal,
): Promise<{status: number; body: string; location?: string}> {
  const lib = url.protocol === 'https:' ? https : http
  const lookupFn = (
    _hostname: string,
    options: {all?: boolean},
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | {address: string; family: number}[],
      family?: number,
    ) => void,
  ) => {
    if (options.all) callback(null, [{address, family}])
    else callback(null, address, family)
  }
  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {accept: 'application/json', 'user-agent': 'ZapGram'},
        servername: url.hostname,
        lookup: lookupFn as http.RequestOptions['lookup'],
      },
      response => {
        const chunks: Buffer[] = []
        let total = 0
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          req.destroy()
          settle(() => reject(new LnurlPayError('bad-response')))
          return
        }
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_BYTES) {
            req.destroy()
            settle(() => reject(new LnurlPayError('bad-response')))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const location = response.headers.location
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              location: Array.isArray(location) ? location[0] : location,
            }),
          )
        })
        response.on('error', error => settle(() => reject(error)))
      },
    )
    // Settle here. `destroy` does not always emit `error` (and a `signal` option
    // can destroy the request first, so a second destroy does nothing).
    const onAbort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      req.destroy(error)
      settle(() => reject(error))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, {once: true})
    req.on('error', error => settle(() => reject(error)))
    req.end()
  })
}

function schemeAllowed(url: URL, nodeEnv: string | undefined): boolean {
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  // No Tor transport. Resolving an onion name would leak it onto clearnet DNS.
  if (host === 'onion' || host.endsWith('.onion')) return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:' || !lnurlLocalTargetsAllowed(nodeEnv)) return false
  return host === 'localhost' || isLoopback(host)
}

function endpointLabel(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

function isLoopback(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = ipv4Of(bare)
  if (v4) return v4.startsWith('127.')
  return bare === '::1'
}

function disallowedV4(ip: string, nodeEnv: string | undefined): boolean {
  if (alwaysBlockedV4.check(ip, 'ipv4')) return true
  if (isPrivateOrLoopbackV4(ip)) return !lnurlLocalTargetsAllowed(nodeEnv)
  return false
}

function isPrivateOrLoopbackV4(ip: string): boolean {
  return (
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  )
}

function disallowedV6(ip: string, nodeEnv: string | undefined): boolean {
  const groups = expandIpv6(ip)
  if (!groups) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (g0 === undefined || g1 === undefined || g2 === undefined || g5 === undefined) return true
  if (groups.every(group => group === 0)) return true
  if (g0 === 0 && groups.slice(1, 7).every(group => group === 0) && g7 === 1) {
    return !lnurlLocalTargetsAllowed(nodeEnv)
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    if (g6 === undefined || g7 === undefined) return true
    return disallowedV4(ipv4FromGroups(g6, g7), nodeEnv)
  }
  // Well-known and local-use NAT64. A reply can embed a metadata or loopback v4.
  if (g0 === 0x64 && g1 === 0xff9b) return true
  if (g0 === 0x2002) {
    if (g6 === undefined) return true
    return disallowedV4(ipv4FromGroups(g1, g2), nodeEnv)
  }
  if (g0 === 0x2001 && g1 === 0) return true
  if (g0 === 0x2001 && g1 === 0x0db8) return true
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  if ((g0 & 0xffc0) === 0xfe80) return true
  // Deprecated site-local (fec0::/10), still used as a private range.
  if ((g0 & 0xffc0) === 0xfec0) return true
  if ((g0 & 0xff00) === 0xff00) return true
  if ((g0 & 0xfe00) === 0xfc00) return !lnurlLocalTargetsAllowed(nodeEnv)
  return false
}

function ipv4Of(ip: string): string | undefined {
  if (isIP(ip) === 4) return ip
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (dotted?.[1] && isIP(dotted[1]) === 4) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!hex?.[1] || !hex[2]) return undefined
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return ipv4FromGroups(hi, lo)
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

function expandIpv6(ip: string): number[] | undefined {
  const lower = ip.toLowerCase().split('%')[0] ?? ''
  const pieces = lower.split('::')
  if (pieces.length > 2) return undefined
  const parse = (part: string | undefined) => {
    if (!part) return []
    return part.split(':').map(group => Number.parseInt(group, 16))
  }
  const left = parse(pieces[0])
  const right = pieces.length === 2 ? parse(pieces[1]) : []
  if ([...left, ...right].some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return undefined
  }
  const missing = 8 - left.length - right.length
  if (pieces.length === 1 && missing !== 0) return undefined
  if (pieces.length === 2 && missing < 1) return undefined
  const groups = [...left, ...Array<number>(Math.max(missing, 0)).fill(0), ...right]
  return groups.length === 8 ? groups : undefined
}

/** DNS and any other wait share the same deadline as the HTTP call. */
export function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LnurlPayError('timeout'))
  return new Promise((resolve, reject) => {
    const fail = () => reject(new LnurlPayError('timeout'))
    signal.addEventListener('abort', fail, {once: true})
    work.then(
      value => {
        signal.removeEventListener('abort', fail)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', fail)
        reject(error)
      },
    )
  })
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function lnurlFailureCode(error: unknown): LnurlPayFailureCode {
  return error instanceof LnurlPayError ? error.code : 'bad-response'
}
