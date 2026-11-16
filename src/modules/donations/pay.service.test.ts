import {describe, expect, mock, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NoNWCAnswerError} from '@core/errors/no-nwc-answer.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import type {PendingDonationPayment} from '@infra/db/types.js'
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
      pending: {save: async () => {}, reconcileUser: async () => []},
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
    const capture = mock(() => undefined)
    const captureException = mock(() => undefined)
    const {deps} = makeDeps({
      posthog: {capture, captureException} as never,
      getUserWallet: mock(async () => ({
        balance: 0,
        payInvoice: mock(async () => ({payment_hash: 'x'})),
      })),
    })
    const result = await deps.payDonation({userId: 1, amountSats: 50, kind: 'one_shot'})
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('no_funds')
    expect(captureException).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'donation_failed',
        distinctId: '1',
        properties: expect.objectContaining({reason: 'no_funds', status: 'failed'}),
      }),
    )
  })

  test('wallet insufficient-funds stays pay_failed and is not captured', async () => {
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
    expect(result).toMatchObject({status: 'failed', reason: 'pay_failed'})
    expect(captureException).not.toHaveBeenCalled()
  })

  test('explicit donation keeps donation_failed reason when the wallet is short', async () => {
    const capture = mock(() => undefined)
    const captureException = mock(() => undefined)
    const {deps} = makeDeps({
      posthog: {capture, captureException} as never,
      getUserWallet: mock(async () => ({
        balance: 100_000,
        payInvoice: mock(async () => {
          throw new InsufficientFundsError()
        }),
      })),
    })
    const result = await deps.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'one_shot',
      rail: 'internal',
    })
    expect(result).toMatchObject({status: 'failed', reason: 'pay_failed'})
    expect(captureException).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'donation_failed',
        properties: expect.objectContaining({reason: 'pay_failed', status: 'failed'}),
      }),
    )
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
    expect(result).toMatchObject({status: 'pending', paymentHash: 'fee-50', error: boom})
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      boom,
      '1',
      expect.objectContaining({stage: 'pay_internal', expected: false}),
    )
  })
})

for (const error of [
  new PaymentPendingError(),
  new Error('transport timeout'),
  new InvoiceAlreadyPaidError(),
]) {
  test(`an uncertain donation (${error.message}) is not recorded or retried through NWC`, async () => {
    const nwcPay = mock(async () => undefined)
    const {deps, insertDonation} = makeDeps({
      getUserWallet: async () => ({
        balance: 100_000,
        payInvoice: async () => {
          throw error
        },
      }),
    })
    const result = await deps.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'one_shot',
      nwc: {payInvoice: nwcPay} as never,
    })
    expect(result).toMatchObject({status: 'pending', paymentHash: 'fee-50', error})
    expect(insertDonation).not.toHaveBeenCalled()
    expect(nwcPay).not.toHaveBeenCalled()
  })
}

for (const rail of ['internal', 'nwc'] as const) {
  for (const error of [
    new PaymentPendingError(),
    new Error('timeout'),
    new InvoiceAlreadyPaidError(),
  ]) {
    test(`${rail} returns the fee invoice hash on unknown pay: ${error.message}`, async () => {
      const payInvoice = mock(async () => {
        throw error
      })
      const {deps, insertDonation} = makeDeps({
        getUserWallet: async () => ({balance: 100_000, payInvoice}),
      })
      expect(
        await deps.payToFeeCollection({
          userId: 1,
          amountSats: 50,
          rail,
          nwc: {payInvoice} as never,
        }),
      ).toMatchObject({
        status: 'pending',
        paymentHash: 'fee-50',
        expiresAt: expect.any(Date),
        error,
      })
      expect(payInvoice).toHaveBeenCalledTimes(1)
      expect(insertDonation).not.toHaveBeenCalled()
    })
  }
}

test('a wallet read failure before pay is a definitive failure without a hash', async () => {
  const {deps} = makeDeps({
    getUserWallet: async () => {
      throw new Error('wallet unavailable')
    },
  })
  expect(await deps.payDonation({userId: 1, amountSats: 50, kind: 'monthly'})).toMatchObject({
    status: 'failed',
    reason: 'pay_failed',
  })
})

test('SendPaused is a definitive failure without a hash', async () => {
  const error = new SendPausedError()
  const {deps, insertDonation} = makeDeps({
    getUserWallet: async () => ({
      balance: 100_000,
      payInvoice: async () => {
        throw error
      },
    }),
  })
  expect(await deps.payDonation({userId: 1, amountSats: 50, kind: 'monthly'})).toEqual({
    status: 'failed',
    reason: 'pay_failed',
    error,
  })
  expect(insertDonation).not.toHaveBeenCalled()
})

test('pending donations emit no failed or successful event', async () => {
  const capture = mock(() => undefined)
  const {deps, insertDonation} = makeDeps({
    posthog: {capture, captureException: mock(() => undefined)} as never,
    getUserWallet: async () => ({
      balance: 100_000,
      payInvoice: async () => {
        throw new PaymentPendingError()
      },
    }),
  })
  await deps.payDonation({userId: 1, amountSats: 50, kind: 'monthly'})
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'donation_pending',
      properties: expect.objectContaining({status: 'pending', payment_hash: 'fee-50'}),
    }),
  )
  for (const event of ['donation_failed', 'donate_sent']) {
    expect(capture).not.toHaveBeenCalledWith(expect.objectContaining({event}))
  }
  expect(insertDonation).not.toHaveBeenCalled()
})

for (const rail of ['nwc', 'auto'] as const) {
  for (const error of [new NWCPaymentFailedError(), new InsufficientFundsError()]) {
    test(`${rail} definite NWC refusal leaves no pending hash: ${error.name}`, async () => {
      const save = mock(async () => {})
      const payInvoice = mock(async () => {
        throw error
      })
      const {deps, createFeeCollectionInvoice, insertDonation} = makeDeps({
        pending: {save, reconcileUser: async () => []},
        getUserWallet: async () => ({balance: 0, payInvoice}),
      })
      const input = {
        userId: 1,
        amountSats: 50,
        kind: 'one_shot' as const,
        rail,
        nwc: {payInvoice} as never,
      }
      for (let i = 0; i < 2; i++) {
        const result = await deps.payDonation(input)
        expect(result).toEqual({status: 'failed', reason: 'pay_failed', error})
        expect(result).not.toHaveProperty('paymentHash')
      }
      expect(save).not.toHaveBeenCalled()
      expect(insertDonation).not.toHaveBeenCalled()
      expect(payInvoice).toHaveBeenCalledTimes(2)
      expect(createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    })
  }
}

for (const error of [
  new NWCTimeoutError(),
  new NoNWCAnswerError(),
  new InvoiceAlreadyPaidError(),
]) {
  test(`uncertain NWC saves the hash and explicit invoice expiry: ${error.name}`, async () => {
    const save = mock(async () => {})
    const expiry = new Date(Date.now() + 60_000)
    const {deps, insertDonation} = makeDeps({
      pending: {save, reconcileUser: async () => []},
      createFeeCollectionInvoice: async () => ({
        payment_hash: 'nwc-pending',
        bolt11: 'invoice',
        expiry,
      }),
    })
    const result = await deps.payDonation({
      userId: 1,
      amountSats: 50,
      kind: 'one_shot',
      rail: 'nwc',
      nwc: {
        payInvoice: async () => {
          throw error
        },
      } as never,
    })
    expect(result).toMatchObject({status: 'pending', paymentHash: 'nwc-pending', expiresAt: expiry})
    expect(save).toHaveBeenCalledWith({
      userId: 1,
      kind: 'one_shot',
      amountSats: 50,
      paymentHash: 'nwc-pending',
      expiresAt: expiry,
    })
    expect(insertDonation).not.toHaveBeenCalled()
  })
}

for (const state of ['pending', 'paid'] as const) {
  test(`explicit retry uses previous ${state} amount and hash without minting another invoice`, async () => {
    const row = {
      userId: 1,
      paymentHash: 'previous',
      kind: 'one_shot' as const,
      amountSats: 21,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }
    const reconcileUser = mock(async () => [{row, state}])
    const save = mock(async () => {})
    const {deps, createFeeCollectionInvoice, payInvoice, insertDonation} = makeDeps({
      pending: {save, reconcileUser},
    })
    const result = await deps.payDonation({userId: 1, amountSats: 100, kind: 'one_shot'})
    expect(result).toMatchObject({status: state, amountSats: 21, paymentHash: 'previous'})
    expect(reconcileUser).toHaveBeenCalledWith(1, 'one_shot')
    expect(createFeeCollectionInvoice).not.toHaveBeenCalled()
    expect(payInvoice).not.toHaveBeenCalled()
    expect(insertDonation).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
}

test('two concurrent explicit retries serialize around pending persistence', async () => {
  const pendingRows: PendingDonationPayment[] = []
  const {deps, createFeeCollectionInvoice} = makeDeps({
    pending: {
      save: async row => {
        pendingRows.push({...row, createdAt: new Date()})
      },
      reconcileUser: async () => pendingRows.map(row => ({row, state: 'pending' as const})),
    },
    getUserWallet: async () => ({
      balance: 100_000,
      payInvoice: async () => {
        throw new PaymentPendingError()
      },
    }),
  })
  const input = {userId: 1, amountSats: 50, kind: 'one_shot' as const}
  const results = await Promise.all([deps.payDonation(input), deps.payDonation(input)])
  expect(results.map(result => result.status)).toEqual(['pending', 'pending'])
  expect(createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(pendingRows).toHaveLength(1)
})

test('feature funding checks and stores its own pending kind', async () => {
  const save = mock(async () => {})
  const reconcileUser = mock(async () => [])
  const {deps} = makeDeps({
    pending: {save, reconcileUser},
    getUserWallet: async () => ({
      balance: 100_000,
      payInvoice: async () => {
        throw new PaymentPendingError()
      },
    }),
  })
  await deps.payDonation({
    userId: 1,
    amountSats: 21,
    kind: 'one_shot',
    pendingKind: 'feature_request',
  })
  expect(reconcileUser).toHaveBeenCalledWith(1, 'feature_request')
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'feature_request',
      amountSats: 21,
      paymentHash: 'fee-21',
      expiresAt: expect.any(Date),
    }),
  )
})
