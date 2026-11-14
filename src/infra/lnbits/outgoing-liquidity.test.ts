import {describe, expect, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import got, {HTTPError, RequestError} from 'got'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import type {BalanceRead, InvoiceOrigin, LiquidityCheckReason} from './outgoing-liquidity.js'
import {
  BACKEND_LIQUIDITY_CHECK_FAILED,
  createOutgoingLiquidityGuard,
  payLeftBackendUnspent,
  probeFundingSource,
  SEND_PAUSED_NO_BACKEND_LIQUIDITY,
} from './outgoing-liquidity.js'

const invoice = mintInvoice({sats: 21, description: 'liquidity'})
const second = mintInvoice({sats: 21, description: 'second'})

function guard(input: {
  origin?: InvoiceOrigin
  read?: () => Promise<BalanceRead>
  fee?: () => Promise<number>
  now?: () => number
  ttlMs?: number
}) {
  const failed: LiquidityCheckReason[] = []
  const paused: unknown[] = []
  let clock = 1_000
  const liquidity = createOutgoingLiquidityGuard({
    classifyInvoice: async () => input.origin ?? 'external',
    readBalance: input.read ?? (async () => ({ok: true, balanceMsat: 100_000})),
    captureCheckFailed: event => {
      failed.push(event.reason)
    },
    capturePaused: event => {
      paused.push(event)
    },
    now: input.now ?? (() => clock),
    ttlMs: input.ttlMs ?? 45_000,
  })
  return {
    liquidity,
    failed,
    paused,
    advance(ms: number) {
      clock += ms
    },
    pay: (bolt11 = invoice.bolt11) =>
      liquidity.assertCanPay({
        bolt11,
        feeReserveMsat: input.fee ?? (async () => 2_000),
      }),
  }
}

describe('createOutgoingLiquidityGuard', () => {
  test('an internal invoice is not checked against the backend', async () => {
    let reads = 0
    const {pay} = guard({
      origin: 'internal',
      read: async () => {
        reads += 1
        return {ok: true, balanceMsat: 0}
      },
    })

    await expect(pay()).resolves.toBeUndefined()
    expect(reads).toBe(0)
  })

  test('zero backend balance pauses an external payment without the fee lookup', async () => {
    let feeReads = 0
    const {pay, paused} = guard({
      read: async () => ({ok: true, balanceMsat: 0}),
      fee: async () => {
        feeReads += 1
        return 2_000
      },
    })

    await expect(pay()).rejects.toBeInstanceOf(SendPausedError)
    expect(feeReads).toBe(0)
    expect(paused).toEqual([{amount_msat: 21_000, fee_reserve_msat: null, backend_balance_msat: 0}])
  })

  test('enough balance plus the fee reserve lets the external payment proceed', async () => {
    const {pay} = guard({read: async () => ({ok: true, balanceMsat: 23_000})})
    await expect(pay()).resolves.toEqual({msat: 23_000, generation: 1})
  })

  test('one millisatoshi under amount plus reserve pauses', async () => {
    const {pay} = guard({read: async () => ({ok: true, balanceMsat: 22_999})})
    await expect(pay()).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a status error does not pause the external payment', async () => {
    const reasons = [
      'http_error',
      'timeout',
      'unauthorized',
      'not_found',
      'funding_source_error',
      'balance_missing',
      'invalid_response',
    ] as const
    for (const reason of reasons) {
      const {pay, failed, paused} = guard({read: async () => ({ok: false, reason})})
      await expect(pay()).resolves.toBeUndefined()
      expect(paused).toEqual([])
      expect(failed).toEqual([reason])
    }
  })

  test('a failed fee-reserve read does not pause when the balance covers the invoice', async () => {
    const {pay, failed} = guard({
      read: async () => ({ok: true, balanceMsat: 1_000_000}),
      fee: async () => {
        throw new Error('fee reserve down')
      },
    })
    await expect(pay()).resolves.toBeUndefined()
    expect(failed).toEqual(['fee_reserve'])
  })

  test('an unknown origin does not pause', async () => {
    const {pay, failed} = guard({origin: 'unknown'})
    await expect(pay()).resolves.toBeUndefined()
    expect(failed).toEqual(['classify_failed'])
  })

  test('a check-failed event is not repeated inside the window', async () => {
    const {pay, failed, advance} = guard({
      read: async () => ({ok: false, reason: 'http_error'}),
    })
    await pay()
    await pay()
    expect(failed).toEqual(['http_error'])
    advance(45_000)
    await pay()
    expect(failed).toEqual(['http_error', 'http_error'])
  })

  test('an approved external payment reduces the cached balance for the next one', async () => {
    const {pay, liquidity} = guard({
      read: async () => ({ok: true, balanceMsat: 30_000}),
    })
    const hold = await pay()
    await expect(
      liquidity.assertCanPay({
        bolt11: second.bolt11,
        feeReserveMsat: async () => 2_000,
      }),
    ).rejects.toBeInstanceOf(SendPausedError)
    if (!hold) throw new Error('Expected a liquidity hold')
    await liquidity.release(hold)
    await expect(
      liquidity.assertCanPay({
        bolt11: second.bolt11,
        feeReserveMsat: async () => 2_000,
      }),
    ).resolves.toEqual({msat: 23_000, generation: 1})
  })

  test('a successful balance is reused until the cache window passes', async () => {
    let reads = 0
    const {pay, advance} = guard({
      read: async () => {
        reads += 1
        return {ok: true, balanceMsat: 100_000}
      },
    })
    await pay()
    await pay(second.bolt11)
    expect(reads).toBe(1)
    advance(45_000)
    await pay()
    expect(reads).toBe(2)
  })
})

describe('probeFundingSource', () => {
  test('no bearer disables the check without reading', async () => {
    let reads = 0
    const mode = await probeFundingSource({
      hasBearer: false,
      read: async () => {
        reads += 1
        return {ok: true, balanceMsat: 1}
      },
    })
    expect(mode).toEqual({mode: 'disabled', reason: 'missing_bearer'})
    expect(reads).toBe(0)
  })

  test('a readable balance is active', async () => {
    const mode = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: true, balanceMsat: 5}),
    })
    expect(mode).toEqual({mode: 'active', reason: 'ok'})
  })

  test('an unreadable balance disables without throwing', async () => {
    const hidden = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: false, reason: 'balance_missing'}),
    })
    expect(hidden).toEqual({mode: 'disabled', reason: 'balance_missing'})
    const crashed = await probeFundingSource({
      hasBearer: true,
      read: async () => {
        throw new Error('down')
      },
    })
    expect(crashed).toEqual({mode: 'disabled', reason: 'check_failed'})
  })
})

describe('payLeftBackendUnspent', () => {
  test('a hold comes back only when LNbits refused the payment', async () => {
    expect(payLeftBackendUnspent(new InvoiceAlreadyPaidError())).toBe(true)
    expect(payLeftBackendUnspent(new InsufficientFundsError())).toBe(true)
    expect(payLeftBackendUnspent(new Error('socket hang up'))).toBe(false)

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const status = Number(new URL(request.url).pathname.slice(1))
        return new Response('no', {status})
      },
    })
    try {
      const refused = await got(`http://127.0.0.1:${server.port}/400`, {
        retry: {limit: 0},
        throwHttpErrors: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      const failed = await got(`http://127.0.0.1:${server.port}/520`, {
        retry: {limit: 0},
        throwHttpErrors: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      const crashed = await got(`http://127.0.0.1:${server.port}/500`, {
        retry: {limit: 0},
        throwHttpErrors: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(HTTPError)
      expect(failed).toBeInstanceOf(HTTPError)
      expect(crashed).toBeInstanceOf(HTTPError)
      expect(payLeftBackendUnspent(refused)).toBe(true)
      expect(payLeftBackendUnspent(failed)).toBe(true)
      expect(payLeftBackendUnspent(crashed)).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('a timed-out pay leaves the hold in place', async () => {
    const hung = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Promise(() => undefined)
      },
    })
    try {
      const timedOut = await got(`http://127.0.0.1:${hung.port}/`, {
        retry: {limit: 0},
        timeout: {request: 50},
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      // got reports this abort as TimeoutError locally and ReadError (ECONNRESET) on CI.
      // Both extend RequestError and neither is an HTTP refusal.
      expect(timedOut).toBeInstanceOf(RequestError)
      expect(timedOut).not.toBeInstanceOf(HTTPError)
      expect(payLeftBackendUnspent(timedOut)).toBe(false)
    } finally {
      hung.stop(true)
    }
  })
})

test('event names stay stable', () => {
  expect(SEND_PAUSED_NO_BACKEND_LIQUIDITY).toBe('send_paused_no_backend_liquidity')
  expect(BACKEND_LIQUIDITY_CHECK_FAILED).toBe('backend_liquidity_check_failed')
})
