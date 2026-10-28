import {describe, expect, mock, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {createDonationPayService} from './pay.service.js'

function makeDeps(overrides: Partial<Parameters<typeof createDonationPayService>[0]> = {}) {
  const insertDonation = mock(async () => ({}))
  const payInvoice = mock(async () => ({payment_hash: 'hash-paid'}))
  const getUserWallet = mock(async () => ({
    balance: 100_000, // msats = 100 sats
    payInvoice,
  }))
  const createFeeCollectionInvoice = mock(async (sats: number) => ({
    payment_hash: `fee-${sats}`,
    bolt11: `lnbc${sats}`,
  }))

  return {
    deps: createDonationPayService({
      createFeeCollectionInvoice,
      getUserWallet,
      insertDonation,
      log: {error: mock(() => {}), info: mock(() => {}), debug: mock(() => {})} as never,
      ...overrides,
    }),
    insertDonation,
    payInvoice,
    getUserWallet,
    createFeeCollectionInvoice,
  }
}

describe('payDonation', () => {
  test('pays internal and inserts ledger on success', async () => {
    const {deps, insertDonation, payInvoice} = makeDeps()
    const result = await deps.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'one_shot',
    })
    // balance 100 sats, amount 50 → internal
    expect(result.status).toBe('paid')
    if (result.status === 'paid') expect(result.rail).toBe('internal')
    expect(payInvoice).toHaveBeenCalled()
    expect(insertDonation).toHaveBeenCalledWith(
      expect.objectContaining({userId: 1, amountSats: 50, kind: 'one_shot'}),
    )
  })

  test('rejects invalid amount', async () => {
    const {deps, insertDonation} = makeDeps()
    const result = await deps.payDonation({userId: 1, amountSats: 0, kind: 'one_shot'})
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('invalid_amount')
    expect(insertDonation).not.toHaveBeenCalled()
  })

  test('falls back to NWC when internal balance is low', async () => {
    const nwcPay = mock(async () => undefined)
    const {deps, insertDonation} = makeDeps({
      getUserWallet: mock(async () => ({
        balance: 1000, // 1 sat
        payInvoice: mock(async () => ({payment_hash: 'x'})),
      })),
    })
    const result = await deps.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'monthly',
      nwc: {payInvoice: nwcPay} as never,
    })
    expect(result.status).toBe('paid')
    if (result.status === 'paid') expect(result.rail).toBe('nwc')
    expect(nwcPay).toHaveBeenCalled()
    expect(insertDonation).toHaveBeenCalled()
  })

  test('fails with no_funds when neither rail works', async () => {
    const captureException = mock(() => undefined)
    const {deps} = makeDeps({
      posthog: {capture: () => undefined, captureException} as never,
      getUserWallet: mock(async () => ({
        balance: 0,
        payInvoice: mock(async () => ({payment_hash: 'x'})),
      })),
    })
    const result = await deps.payDonation({userId: 1, amountSats: 50, kind: 'one_shot'})
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('no_funds')
    expect(captureException).not.toHaveBeenCalled()
  })

  test('wallet insufficient-funds is no_funds and is not captured', async () => {
    const captureException = mock(() => undefined)
    const {deps} = makeDeps({
      posthog: {capture: () => undefined, captureException} as never,
      getUserWallet: mock(async () => ({
        balance: 100_000,
        payInvoice: mock(async () => {
          throw new InsufficientFundsError()
        }),
      })),
    })
    const result = await deps.payToFeeCollection({
      userId: 1,
      amountSats: 50,
      rail: 'internal',
    })
    expect(result).toMatchObject({status: 'failed', reason: 'no_funds'})
    expect(captureException).not.toHaveBeenCalled()
  })

  test('unexpected pay errors are captured as exceptions', async () => {
    const captureException = mock(() => undefined)
    const boom = new Error('lnbits 500')
    const {deps} = makeDeps({
      posthog: {capture: () => undefined, captureException} as never,
      getUserWallet: mock(async () => ({
        balance: 100_000,
        payInvoice: mock(async () => {
          throw boom
        }),
      })),
    })
    const result = await deps.payToFeeCollection({
      userId: 1,
      amountSats: 50,
      rail: 'internal',
    })
    expect(result).toMatchObject({status: 'failed', reason: 'pay_failed', error: boom})
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      boom,
      '1',
      expect.objectContaining({stage: 'pay_internal', expected: false}),
    )
  })
})
