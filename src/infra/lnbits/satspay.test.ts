import {afterEach, describe, expect, test} from 'bun:test'
import {HTTPError} from 'got'
import {SatsPayClient, SatspayExtensionDisabledError} from './satspay.js'

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

  test('probeExtension GETs /satspay/api/v1 and treats 200 as up', async () => {
    const calls: {method: string; path: string}[] = []
    await withClient(
      request => {
        calls.push({method: request.method, path: new URL(request.url).pathname})
        return Response.json({message: 'SatsPay API enabled.'})
      },
      async client => {
        expect(await client.probeExtension()).toBe('up')
      },
    )
    expect(calls).toEqual([{method: 'GET', path: '/satspay/api/v1'}])
  })

  test('probeExtension treats the disabled-extension 404 as down', async () => {
    await withClient(
      () => Response.json({detail: "Extension 'satspay' disabled"}, {status: 404}),
      async client => {
        expect(await client.probeExtension()).toBe('down')
      },
    )
  })

  test('probeExtension treats a generic Not Found as inconclusive', async () => {
    await withClient(
      () => Response.json({detail: 'Not Found'}, {status: 404}),
      async client => {
        expect(await client.probeExtension()).toBe('inconclusive')
      },
    )
  })

  test('probeExtension treats 401 and 403 as inconclusive', async () => {
    for (const status of [401, 403]) {
      await withClient(
        () => Response.json({detail: 'Unauthorized.'}, {status}),
        async client => {
          expect(await client.probeExtension()).toBe('inconclusive')
        },
      )
    }
  })

  test('createCharge throws SatspayExtensionDisabledError for the disabled body', async () => {
    await withClient(
      () => Response.json({detail: "Extension 'satspay' disabled"}, {status: 404}),
      async client => {
        await expect(
          client.createCharge({
            onchainwallet: 'wo-1',
            amount: 1000,
            time: 1440,
            description: 'ZapGram',
          }),
        ).rejects.toBeInstanceOf(SatspayExtensionDisabledError)
      },
    )
  })

  test('createCharge rethrows other charge errors unchanged', async () => {
    await withClient(
      () => Response.json({detail: 'nope'}, {status: 500}),
      async client => {
        await expect(
          client.createCharge({
            onchainwallet: 'wo-1',
            amount: 1000,
            time: 1440,
            description: 'ZapGram',
          }),
        ).rejects.toBeInstanceOf(HTTPError)
      },
    )
  })
})

async function withClient(
  handler: (request: Request) => Response | Promise<Response>,
  run: (client: SatsPayClient) => Promise<void>,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
  })
  try {
    const client = new SatsPayClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'k',
    })
    await run(client)
  } finally {
    server.stop(true)
  }
}

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
