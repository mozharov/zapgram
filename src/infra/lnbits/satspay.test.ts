import {afterEach, describe, expect, test} from 'bun:test'
import {SatsPayClient} from './satspay.js'

describe('SatsPayClient', () => {
  let stop: (() => void) | undefined

  afterEach(() => {
    stop?.()
    stop = undefined
  })

  test('createCharge posts on-chain-only body and parses charge', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.method).toBe('POST')
        expect(new URL(request.url).pathname).toBe('/satspay/api/v1/charge')
        const body = (await request.json()) as Record<string, unknown>
        expect(body.onchainwallet).toBe('wo-1')
        expect(body.amount).toBe(1000)
        expect(body.time).toBe(1440)
        expect(body.lnbitswallet).toBeUndefined()
        expect(body.webhook).toBe('https://bot.example/satspay/webhook/s')
        expect(body.zeroconf).toBe(true)
        return Response.json({
          id: 'ch-1',
          user: 'u1',
          amount: 1000,
          time: 1440,
          timestamp: '2026-08-08T12:00:00Z',
          balance: 0,
          pending: 0,
          zeroconf: true,
          paid: false,
          onchainwallet: 'wo-1',
          onchainaddress: 'bc1qfresh',
          webhook: body.webhook,
          description: 'ZapGram',
        })
      },
    })
    stop = () => server.stop(true)

    const client = new SatsPayClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'k',
    })
    const charge = await client.createCharge({
      onchainwallet: 'wo-1',
      amount: 1000,
      time: 1440,
      description: 'ZapGram',
      webhook: 'https://bot.example/satspay/webhook/s',
      zeroconf: true,
    })
    expect(charge.id).toBe('ch-1')
    expect(charge.onchainaddress).toBe('bc1qfresh')
    expect(charge.paid).toBe(false)
  })

  test('getCharge and checkChargeBalance', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (request.method === 'GET' && path === '/satspay/api/v1/charge/ch-1') {
          return Response.json(paidCharge())
        }
        if (request.method === 'PUT' && path === '/satspay/api/v1/charge/balance/ch-1') {
          return Response.json(paidCharge())
        }
        return new Response('nope', {status: 404})
      },
    })
    stop = () => server.stop(true)

    const client = new SatsPayClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'k',
    })
    expect((await client.getCharge('ch-1')).paid).toBe(true)
    expect((await client.checkChargeBalance('ch-1')).balance).toBe(1000)
  })
})

function paidCharge() {
  return {
    id: 'ch-1',
    user: 'u1',
    amount: 1000,
    time: 1440,
    timestamp: '2026-08-08T12:00:00Z',
    balance: 1000,
    pending: 0,
    paid: true,
    onchainwallet: 'wo-1',
    onchainaddress: 'bc1qfresh',
    extra: JSON.stringify({txids: ['txid1']}),
  }
}
