import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {LnurlPayError} from '@core/lightning/lnurl-pay.js'
import type {PaymentRequest} from '@core/lightning/payment-request.js'
import {encode, toWords} from 'bech32'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {fetchLnurlPay, requestLnurlInvoice} from './lnurl-pay.js'

const METADATA = JSON.stringify([
  ['text/plain', 'Pay Alice'],
  ['text/identifier', 'alice@example.com'],
])
const HASH = createHash('sha256').update(METADATA).digest('hex')

function encodeLnurl(url: string): string {
  return encode('lnurl', toWords(Buffer.from(url)), 5000)
}

function payDocument(callback: string, min = 1_000, max = 100_000) {
  return {
    tag: 'payRequest',
    callback,
    minSendable: min,
    maxSendable: max,
    metadata: METADATA,
    commentAllowed: 40,
  }
}

describe('fetchLnurlPay', () => {
  test('loads a lightning address from the recipient and not from the Alby proxy', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      return Response.json(payDocument('https://localhost/.well-known/lnurlp/alice/callback'))
    }) as typeof fetch
    try {
      const quote = await fetchLnurlPay({kind: 'lightning-address', value: 'alice@localhost'})
      expect(calls).toEqual(['https://localhost/.well-known/lnurlp/alice'])
      expect(calls.some(url => url.includes('api.getalby.com'))).toBe(false)
      expect(quote.minSats).toBe(1)
      expect(quote.maxSats).toBe(100)
      expect(quote.metadata).toBe(METADATA)
      expect(quote.description).toBe('Pay Alice')
    } finally {
      globalThis.fetch = original
    }
  })

  test('follows a redirect to the pay request and refuses a redirect into a metadata address', async () => {
    let port = 0
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/go') {
          return Response.redirect(`http://127.0.0.1:${port}/pay`, 302)
        }
        if (url.pathname === '/trap') {
          return Response.redirect('http://169.254.169.254/latest', 302)
        }
        return Response.json(payDocument(`http://127.0.0.1:${port}/callback`))
      },
    })
    if (server.port === undefined) throw new Error('LNURL test server has no port')
    port = server.port
    try {
      const quote = await fetchLnurlPay({
        kind: 'lnurl',
        value: encodeLnurl(`http://127.0.0.1:${server.port}/go`),
      })
      expect(quote.callback).toContain('/callback')
      await expect(
        fetchLnurlPay({
          kind: 'lnurl',
          value: encodeLnurl(`http://127.0.0.1:${server.port}/trap`),
        }),
      ).rejects.toMatchObject({code: 'bad-response'})
    } finally {
      server.stop(true)
    }
  })

  test('does not call a link-local or private address', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('no', {status: 500})
    }) as typeof fetch
    try {
      await expect(
        fetchLnurlPay({
          kind: 'lnurl',
          value: encodeLnurl('http://169.254.169.254/latest'),
        }),
      ).rejects.toMatchObject({code: 'bad-response'})
      await expect(
        fetchLnurlPay({kind: 'lnurl', value: encodeLnurl('http://10.1.2.3/pay')}),
      ).rejects.toMatchObject({code: 'bad-response'})
      expect(calls).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  test('reports a timeout, a server error, and a body that is not a pay request', async () => {
    const closing = new AbortController()
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/hang') {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 30_000)
            const done = () => {
              clearTimeout(timer)
              resolve(undefined)
            }
            closing.signal.addEventListener('abort', done)
            request.signal.addEventListener('abort', done)
          })
          return new Response('late', {status: 504})
        }
        if (path === '/down') return new Response('down', {status: 500})
        if (path === '/text') return new Response('not-json', {status: 200})
        return Response.json({status: 'ERROR', reason: 'no'})
      },
    })
    const lnurl = (path: string): PaymentRequest => ({
      kind: 'lnurl',
      value: encodeLnurl(`http://127.0.0.1:${server.port}${path}`),
    })
    try {
      await expect(fetchLnurlPay(lnurl('/hang'))).rejects.toMatchObject({code: 'timeout'})
      await expect(fetchLnurlPay(lnurl('/down'))).rejects.toMatchObject({code: 'server'})
      await expect(fetchLnurlPay(lnurl('/text'))).rejects.toMatchObject({code: 'bad-response'})
      await expect(fetchLnurlPay(lnurl('/error'))).rejects.toMatchObject({code: 'server'})
    } finally {
      closing.abort()
      server.stop(true)
    }
  }, 20_000)
})

describe('requestLnurlInvoice', () => {
  test('returns the bolt11 only when the amount and description hash match, and sends no comment', async () => {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        seen.push(`${url.pathname}?${url.searchParams.toString()}`)
        const mode = url.pathname.slice(1)
        if (mode === 'down') return new Response('no', {status: 503})
        const asked = Number(url.searchParams.get('amount'))
        const sats = mode === 'amount' ? asked / 1000 + 1 : asked / 1000
        const hash = mode === 'hash' ? createHash('sha256').update('nope').digest('hex') : HASH
        const invoice = mintInvoice({
          sats,
          description: 'Pay Alice',
          descriptionHash: mode === 'plain' ? undefined : hash,
        })
        return Response.json({pr: invoice.bolt11})
      },
    })
    const callback = (mode: string) => `http://127.0.0.1:${server.port}/${mode}?keep=1`
    const quote = {
      minMsat: 1_000,
      maxMsat: 100_000,
      minSats: 1,
      maxSats: 100,
      metadata: METADATA,
      description: 'Pay Alice',
      callback: callback('ok'),
    }
    try {
      const pr = await requestLnurlInvoice(quote, 30)
      expect(pr.startsWith('lnbc')).toBe(true)
      expect(seen[0]).toContain('amount=30000')
      expect(seen[0]).toContain('keep=1')
      expect(seen[0]).not.toContain('comment')

      const plain = await requestLnurlInvoice({...quote, callback: callback('plain')}, 30)
      expect(plain.startsWith('lnbc')).toBe(true)

      await expect(
        requestLnurlInvoice({...quote, callback: callback('amount')}, 30),
      ).rejects.toMatchObject({code: 'amount'})
      await expect(
        requestLnurlInvoice({...quote, callback: callback('hash')}, 30),
      ).rejects.toMatchObject({code: 'description-hash'})
      await expect(
        requestLnurlInvoice({...quote, callback: callback('down')}, 30),
      ).rejects.toMatchObject({code: 'server'})
      await expect(requestLnurlInvoice(quote, 0)).rejects.toBeInstanceOf(LnurlPayError)
      expect(seen.some(url => url.includes('comment'))).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
