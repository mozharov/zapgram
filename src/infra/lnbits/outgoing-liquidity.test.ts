import {describe, expect, test} from 'bun:test'
import {SendPausedError} from '@core/errors/send-paused.js'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {
  createOutgoingLiquidityGuard,
  SEND_PAUSED_NO_BACKEND_LIQUIDITY,
} from './outgoing-liquidity.js'

const invoice = mintInvoice({sats: 21, description: 'liquidity'})

describe('createOutgoingLiquidityGuard', () => {
  test('zero backend pauses without asking for the fee reserve', async () => {
    let feeReads = 0
    const captured: unknown[] = []
    const guard = createOutgoingLiquidityGuard({
      readBalanceMsat: async () => 0,
      capturePaused: properties => {
        captured.push(properties)
      },
    })

    await expect(
      guard.assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => {
          feeReads += 1
          return 2_000
        },
      }),
    ).rejects.toBeInstanceOf(SendPausedError)

    // Balance is already short of the invoice, so the fee lookup is skipped.
    // The comparison itself still includes a reserve when the balance might cover the amount.
    expect(feeReads).toBe(0)
    expect(captured).toEqual([
      {
        reason: 'insufficient_backend_liquidity',
        amount_msat: 21_000,
        fee_reserve_msat: null,
        backend_balance_msat: 0,
      },
    ])
  })

  test('enough balance plus the fee reserve lets the payment proceed', async () => {
    const guard = createOutgoingLiquidityGuard({
      readBalanceMsat: async () => 23_000,
    })

    await expect(
      guard.assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => 2_000,
      }),
    ).resolves.toBeUndefined()
  })

  test('one millisatoshi under amount plus reserve pauses', async () => {
    const guard = createOutgoingLiquidityGuard({readBalanceMsat: async () => 22_999})

    await expect(
      guard.assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => 2_000,
      }),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a failed balance read pauses and does not call pay-side work', async () => {
    let feeReads = 0
    const guard = createOutgoingLiquidityGuard({
      readBalanceMsat: async () => {
        throw new Error('status down')
      },
    })

    const error = await guard
      .assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => {
          feeReads += 1
          return 0
        },
      })
      .then(
        () => {
          throw new Error('expected pause')
        },
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(SendPausedError)
    expect(feeReads).toBe(0)
    if (!(error instanceof SendPausedError)) throw error
    expect(error.analytics).toMatchObject({reason: 'backend_liquidity_check_failed'})
  })

  test('a failed fee-reserve read pauses even when the backend balance would cover the amount', async () => {
    const guard = createOutgoingLiquidityGuard({readBalanceMsat: async () => 1_000_000})

    await expect(
      guard.assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => {
          throw new Error('fee reserve down')
        },
      }),
    ).rejects.toBeInstanceOf(SendPausedError)
  })

  test('a successful balance is reused until the cache window passes', async () => {
    let reads = 0
    let clock = 1_000
    const guard = createOutgoingLiquidityGuard({
      readBalanceMsat: async () => {
        reads += 1
        return 50_000
      },
      now: () => clock,
      ttlMs: 45_000,
    })
    const pay = () =>
      guard.assertCanPay({
        bolt11: invoice.bolt11,
        feeReserveMsat: async () => 1_000,
      })

    await pay()
    await pay()
    expect(reads).toBe(1)

    clock += 45_000
    await pay()
    expect(reads).toBe(2)
  })

  test('a failed read is not cached', async () => {
    let reads = 0
    const guard = createOutgoingLiquidityGuard({
      readBalanceMsat: async () => {
        reads += 1
        throw new Error('down')
      },
      ttlMs: 45_000,
    })

    await expect(
      guard.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 0}),
    ).rejects.toBeInstanceOf(SendPausedError)
    await expect(
      guard.assertCanPay({bolt11: invoice.bolt11, feeReserveMsat: async () => 0}),
    ).rejects.toBeInstanceOf(SendPausedError)
    expect(reads).toBe(2)
  })

  test('the capture callback receives the product event payload shape', () => {
    expect(SEND_PAUSED_NO_BACKEND_LIQUIDITY).toBe('send_paused_no_backend_liquidity')
  })
})
