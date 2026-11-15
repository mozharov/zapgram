import {describe, expect, test} from 'bun:test'
import {Writable} from 'node:stream'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import got, {HTTPError, RequestError} from 'got'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {createLogger} from '../logger.js'
import {interpretFundingSourceStatus} from './master-wallet.js'
import type {BalanceRead, InvoiceOrigin, LiquidityCheckReason} from './outgoing-liquidity.js'
import {
  BACKEND_LIQUIDITY_CHECK_FAILED,
  createOutgoingLiquidityGuard,
  payLeftBackendUnspent,
  probeFundingSource,
  SEND_PAUSED_NO_BACKEND_LIQUIDITY,
} from './outgoing-liquidity.js'

function held(msat: number, generation: number, bolt11: string, walletId = '') {
  return {
    msat,
    generation,
    paymentHash: decodeInvoice(bolt11).paymentHash.toLowerCase(),
    walletId,
  }
}

const invoice = mintInvoice({sats: 21, description: 'liquidity'})
const second = mintInvoice({sats: 21, description: 'second'})

function guard(input: {
  origin?: InvoiceOrigin
  read?: () => Promise<BalanceRead>
  fee?: () => Promise<number>
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
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
    failureTtlMs: input.failureTtlMs,
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
    await expect(pay()).resolves.toEqual(held(23_000, 1, invoice.bolt11))
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
    ).resolves.toEqual(held(23_000, 1, second.bolt11))
  })

  test('a failed balance read is reused for a few seconds and then tried again', async () => {
    let reads = 0
    const {pay, advance} = guard({
      read: async () => {
        reads += 1
        return {ok: false, reason: 'timeout'}
      },
      failureTtlMs: 5_000,
    })
    await pay()
    await pay()
    expect(reads).toBe(1)
    advance(5_000)
    await pay()
    expect(reads).toBe(2)
  })

  test('an internal payment does not wait for a hung balance read', async () => {
    let finish: (read: BalanceRead) => void = () => {}
    const hung = new Promise<BalanceRead>(resolve => {
      finish = resolve
    })
    let reads = 0
    const liquidity = createOutgoingLiquidityGuard({
      classifyInvoice: async bolt11 => (bolt11 === invoice.bolt11 ? 'external' : 'internal'),
      readBalance: () => {
        reads += 1
        return hung
      },
    })
    const external = liquidity.assertCanPay({
      bolt11: invoice.bolt11,
      feeReserveMsat: async () => 2_000,
    })
    try {
      await Promise.race([
        liquidity.assertCanPay({
          bolt11: second.bolt11,
          feeReserveMsat: async () => 2_000,
        }),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('internal pay waited on the balance read')), 500)
        }),
      ])
    } finally {
      finish({ok: false, reason: 'timeout'})
    }
    expect(reads).toBe(1)
    await expect(external).resolves.toBeUndefined()
  })

  test('a successful balance is reused until the cache window passes', async () => {
    let reads = 0
    const {pay, advance} = guard({
      read: async () => {
        reads += 1
        return {ok: true, balanceMsat: 100_000}
      },
    })
    const third = mintInvoice({sats: 21, description: 'third'})
    await pay()
    await pay(second.bolt11)
    expect(reads).toBe(1)
    advance(45_000)
    await pay(third.bolt11)
    expect(reads).toBe(2)
  })

  test('another wallet paying the same invoice is checked against the balance', async () => {
    const {liquidity} = guard({read: async () => ({ok: true, balanceMsat: 23_000})})
    await expect(
      liquidity.assertCanPay({
        bolt11: invoice.bolt11,
        payerWalletId: 'wallet-a',
        feeReserveMsat: async () => 2_000,
      }),
    ).resolves.toEqual(held(23_000, 1, invoice.bolt11, 'wallet-a'))
    await expect(
      liquidity.assertCanPay({
        bolt11: invoice.bolt11,
        payerWalletId: 'wallet-b',
        feeReserveMsat: async () => 2_000,
      }),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a shared reservation stays until the last live pay of that wallet and invoice ends', async () => {
    const {liquidity} = guard({read: async () => ({ok: true, balanceMsat: 23_000})})
    const [first, secondPay] = await Promise.all([
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
    ])
    if (!first || !secondPay) throw new Error('Expected both live pays to share a hold')
    await liquidity.release(first)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
    await liquidity.release(secondPay)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).resolves.toEqual(held(23_000, 1, second.bolt11))
  })

  test('a settled shared hold is not subtracted again after the balance is reread', async () => {
    let balance = 46_000
    const {liquidity, advance} = guard({
      read: async () => ({ok: true, balanceMsat: balance}),
      ttlMs: 1_000,
    })
    const [first, secondPay] = await Promise.all([
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
    ])
    if (!first || !secondPay) throw new Error('Expected both live pays to share a hold')
    await liquidity.settle(first)
    balance = 23_000
    advance(1_000)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).resolves.toEqual(held(23_000, 2, second.bolt11))
    await liquidity.release(secondPay)
    const third = mintInvoice({sats: 21, description: 'third-after-release'})
    await expect(
      liquidity.assertCanPay({bolt11: third.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a settled pay keeps the reservation when the duplicate is already paid', async () => {
    const {liquidity} = guard({read: async () => ({ok: true, balanceMsat: 23_000})})
    const [first, secondPay] = await Promise.all([
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
      liquidity.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 2_000}),
    ])
    if (!first || !secondPay) throw new Error('Expected both live pays to share a hold')
    await liquidity.settle(first)
    await liquidity.release(secondPay)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a released hold does not inflate a clamped remainder', async () => {
    let balance = 30_000
    const {pay, liquidity, advance} = guard({
      read: async () => ({ok: true, balanceMsat: balance}),
      ttlMs: 1_000,
    })
    const hold = await pay()
    if (!hold) throw new Error('Expected a liquidity hold')
    balance = 0
    advance(1_000)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
    await liquidity.release(hold)
    const tiny = mintInvoice({sats: 1, description: 'tiny'})
    await expect(
      liquidity.assertCanPay({bolt11: tiny.bolt11, feeReserveMsat: async () => 0}),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a timed-out hold is not subtracted again after the balance is reread', async () => {
    const {pay, liquidity, advance} = guard({
      read: async () => ({ok: true, balanceMsat: 30_000}),
      ttlMs: 1_000,
    })
    const hold = await pay()
    if (!hold) throw new Error('Expected a liquidity hold')
    await liquidity.abandon(hold)
    advance(1_000)
    await expect(pay()).resolves.toEqual(held(23_000, 2, invoice.bolt11))
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a settled pay does not wait behind a balance check that has not started', async () => {
    let reads = 0
    let releaseSecond: () => void = () => undefined
    const secondRead = new Promise<void>(resolve => {
      releaseSecond = resolve
    })
    let markSecondStarted: () => void = () => undefined
    const secondStarted = new Promise<void>(resolve => {
      markSecondStarted = resolve
    })
    const order: string[] = []
    const third = mintInvoice({sats: 5, description: 'third-queued'})
    const {liquidity} = guard({
      ttlMs: 0,
      read: async () => {
        reads += 1
        if (reads === 1) return {ok: true, balanceMsat: 100_000}
        if (reads === 2) {
          markSecondStarted()
          await secondRead
          return {ok: true, balanceMsat: 100_000}
        }
        order.push('read3')
        return {ok: true, balanceMsat: 100_000}
      },
    })
    const hold = await liquidity.assertCanPay({
      bolt11: invoice.bolt11,
      feeReserveMsat: async () => 2_000,
    })
    if (!hold) throw new Error('Expected a hold')
    const pendingSecond = liquidity.assertCanPay({
      bolt11: second.bolt11,
      feeReserveMsat: async () => 2_000,
    })
    await secondStarted
    const pendingThird = liquidity.assertCanPay({
      bolt11: third.bolt11,
      feeReserveMsat: async () => 2_000,
    })
    const settling = liquidity.settle(hold).then(() => {
      order.push('settle')
    })
    releaseSecond()
    await settling
    await pendingSecond
    await pendingThird
    expect(order[0]).toBe('settle')
    expect(order).toContain('read3')
  })

  test('no bearer does not classify or warn', async () => {
    let classified = 0
    const failed: string[] = []
    const liquidity = createOutgoingLiquidityGuard({
      hasBearer: false,
      classifyInvoice: async () => {
        classified += 1
        return 'unknown'
      },
      readBalance: async () => ({ok: true, balanceMsat: 0}),
      captureCheckFailed: event => {
        failed.push(event.reason)
      },
    })
    await liquidity.assertCanPay({
      bolt11: invoice.bolt11,
      feeReserveMsat: async () => 2_000,
    })
    await liquidity.assertCanPay({
      bolt11: second.bolt11,
      knownInternal: true,
      feeReserveMsat: async () => 2_000,
    })
    expect(classified).toBe(0)
    expect(failed).toEqual([])
  })

  test('a balance reread keeps an unfinished hold', async () => {
    let balance = 30_000
    const {pay, liquidity, advance} = guard({
      read: async () => ({ok: true, balanceMsat: balance}),
      ttlMs: 1_000,
    })
    const hold = await pay()
    if (!hold) throw new Error('Expected a liquidity hold')
    advance(1_000)
    await expect(
      liquidity.assertCanPay({bolt11: second.bolt11, feeReserveMsat: async () => 2_000}),
    ).rejects.toBeInstanceOf(SendPausedError)
    balance = 7_000
    await liquidity.settle(hold)
    advance(1_000)
    await expect(
      liquidity.assertCanPay({
        bolt11: mintInvoice({sats: 5, description: 'after settle'}).bolt11,
        feeReserveMsat: async () => 2_000,
      }),
    ).resolves.toEqual(expect.objectContaining({msat: 7_000, generation: 3}))
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
      probeClassify: async () => {
        throw new Error('should not classify')
      },
    })
    expect(mode).toEqual({mode: 'disabled', reason: 'missing_bearer', classify: 'missing_bearer'})
    expect(reads).toBe(0)
  })

  test('a zero balance with no error stays active and is named on the startup reason', async () => {
    const mode = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: true, balanceMsat: 0}),
      probeClassify: async () => true,
    })
    expect(mode).toEqual({mode: 'active', reason: 'zero_balance', classify: 'ok'})
  })

  test('a readable balance is active', async () => {
    const mode = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: true, balanceMsat: 5}),
      probeClassify: async () => true,
    })
    expect(mode).toEqual({mode: 'active', reason: 'ok', classify: 'ok'})
  })

  test('a failed classification probe is reported without throwing', async () => {
    const mode = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: true, balanceMsat: 5}),
      probeClassify: async () => false,
    })
    expect(mode).toEqual({mode: 'degraded', reason: 'ok', classify: 'failed'})
  })

  test('an unreadable balance disables without throwing', async () => {
    const hidden = await probeFundingSource({
      hasBearer: true,
      read: async () => ({ok: false, reason: 'balance_missing'}),
      probeClassify: async () => true,
    })
    expect(hidden).toEqual({mode: 'disabled', reason: 'balance_missing', classify: 'ok'})
    const crashed = await probeFundingSource({
      hasBearer: true,
      read: async () => {
        throw new Error('down')
      },
      probeClassify: async () => {
        throw new Error('list down')
      },
    })
    expect(crashed).toEqual({mode: 'disabled', reason: 'check_failed', classify: 'failed'})
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
        const path = new URL(request.url).pathname
        if (path === '/520failed') {
          return Response.json({status: 'failed', detail: 'nope'}, {status: 520})
        }
        if (path === '/520open') return Response.json({status: 'pending'}, {status: 520})
        const status = Number(path.slice(1))
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
      const failed = await got(`http://127.0.0.1:${server.port}/520failed`, {
        retry: {limit: 0},
        throwHttpErrors: true,
        responseType: 'json',
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      const open = await got(`http://127.0.0.1:${server.port}/520open`, {
        retry: {limit: 0},
        throwHttpErrors: true,
        responseType: 'json',
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
      const timeout = await got(`http://127.0.0.1:${server.port}/408`, {
        retry: {limit: 0},
        throwHttpErrors: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      const limited = await got(`http://127.0.0.1:${server.port}/429`, {
        retry: {limit: 0},
        throwHttpErrors: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(payLeftBackendUnspent(refused)).toBe(true)
      expect(payLeftBackendUnspent(failed)).toBe(true)
      expect(payLeftBackendUnspent(open)).toBe(false)
      expect(payLeftBackendUnspent(crashed)).toBe(false)
      expect(payLeftBackendUnspent(timeout)).toBe(false)
      expect(payLeftBackendUnspent(limited)).toBe(false)
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

test('a non-string funding source error is not treated as a healthy balance', () => {
  expect(
    interpretFundingSourceStatus({
      funding_source_balance_msat: 5,
      funding_source_error: {detail: 'nwc'},
    }),
  ).toEqual({ok: false, reason: 'funding_source_error'})
  expect(
    interpretFundingSourceStatus({funding_source_balance_msat: 5, funding_source_error: ''}),
  ).toEqual({ok: true, balanceMsat: 5})
  expect(
    interpretFundingSourceStatus({funding_source_balance_msat: 5, funding_source_error: null}),
  ).toEqual({ok: true, balanceMsat: 5})
})

test('a pause log does not include the invoice', async () => {
  const lines: string[] = []
  const log = createLogger(
    {LOG_LEVEL: 'info', NODE_ENV: 'test'},
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    }),
  )
  const liquidity = createOutgoingLiquidityGuard({
    classifyInvoice: async () => 'external',
    readBalance: async () => ({ok: true, balanceMsat: 0}),
    log,
  })
  await expect(
    liquidity.assertCanPay({
      bolt11: invoice.bolt11,
      feeReserveMsat: async () => 2_000,
    }),
  ).rejects.toBeInstanceOf(SendPausedError)
  const text = lines.join('\n')
  expect(text).toContain('Outgoing payment paused')
  expect(text).not.toContain(invoice.bolt11)
  expect(text).not.toContain('payment_request')
})

test('event names stay stable', () => {
  expect(SEND_PAUSED_NO_BACKEND_LIQUIDITY).toBe('send_paused_no_backend_liquidity')
  expect(BACKEND_LIQUIDITY_CHECK_FAILED).toBe('backend_liquidity_check_failed')
})
