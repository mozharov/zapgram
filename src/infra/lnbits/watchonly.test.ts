import {afterEach, describe, expect, test} from 'bun:test'
import {WatchOnlyClient} from './watchonly.js'

describe('WatchOnlyClient', () => {
  let stop: (() => void) | undefined

  afterEach(() => {
    stop?.()
    stop = undefined
  })

  test('createWallet POSTs masterpub and parses response', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.method).toBe('POST')
        expect(new URL(request.url).pathname).toBe('/watchonly/api/v1/wallet')
        expect(request.headers.get('X-Api-Key')).toBe('admin-key')
        const body = (await request.json()) as Record<string, unknown>
        expect(body.masterpub).toBe('zpub6test')
        expect(body.title).toBe('chat-1')
        expect(body.network).toBe('Mainnet')
        return Response.json({
          id: 'wo-1',
          user: 'u1',
          masterpub: 'zpub6test',
          fingerprint: 'abcd1234',
          title: 'chat-1',
          address_no: -1,
          balance: 0,
          type: 'wpkh',
          network: 'Mainnet',
          meta: '{}',
        })
      },
    })
    stop = () => server.stop(true)

    const client = new WatchOnlyClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'admin-key',
    })
    const wallet = await client.createWallet({masterpub: 'zpub6test', title: 'chat-1'})
    expect(wallet.id).toBe('wo-1')
    expect(wallet.fingerprint).toBe('abcd1234')
  })

  test('getFreshAddress returns address payload', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe('/watchonly/api/v1/address/wo-1')
        return Response.json({
          id: 'addr-1',
          address: 'bc1qtest',
          wallet: 'wo-1',
          amount: 0,
          branch_index: 0,
          address_index: 0,
          has_activity: false,
        })
      },
    })
    stop = () => server.stop(true)

    const client = new WatchOnlyClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'k',
    })
    const address = await client.getFreshAddress('wo-1')
    expect(address.address).toBe('bc1qtest')
  })

  test('deleteWallet issues DELETE', async () => {
    let deleted = false
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        expect(request.method).toBe('DELETE')
        deleted = true
        return new Response('', {status: 204})
      },
    })
    stop = () => server.stop(true)

    const client = new WatchOnlyClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      adminKey: 'k',
    })
    await client.deleteWallet('wo-1')
    expect(deleted).toBe(true)
  })
})
