import {describe, expect, mock, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NoNWCAnswerError} from '@core/errors/no-nwc-answer.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import type {PendingDonationPayment} from '@infra/db/types.js'
import {HTTPError} from 'got'
import {createDonationPayService, type DonationPayDeps} from './pay.service.js'
import {donationPayHarness} from './pay.test-support.js'

function makeDeps(
  overrides: Omit<Partial<DonationPayDeps>, 'pending'> & {
    pending?: Partial<DonationPayDeps['pending']>
  } = {},
) {
  const insertDonation = mock(
    async (_input: Parameters<DonationPayDeps['insertDonation']>[0]) => ({}),
  )
  const payInvoice = mock(async () => ({payment_hash: 'hash-paid'}))
  const getUserWallet = mock(async () => ({
    balance: 100_000, // msats = 100 sats
    payInvoice,
  }))
  const createFeeCollectionInvoice = mock(async (sats: number) => ({
    payment_hash: `fee-${sats}`,
    bolt11: `lnbc${sats}`,
  }))

  let issued: Parameters<DonationPayDeps['issuance']['saveIssued']>[1] | undefined
  const pending = {
    save: async () => {},
    reconcileUser: async () => [],
    complete: async () => {
      if (issued) await insertDonation({...issued, kind: 'one_shot'})
    },
    remove: async () => {},
    ...overrides.pending,
  }
  const issuance = {
    reserveIssuance: async () => ({key: 'slot', token: 'owner', rows: []}),
    releaseIssuance: async () => {},
    saveIssued: mock(
      async (
        _slot: {key: string; token: string},
        row: Parameters<DonationPayDeps['issuance']['saveIssued']>[1],
      ) => {
        issued = row
        await pending.save(row)
        return true
      },
    ),
    ...overrides.issuance,
  }
  return {
    deps: createDonationPayService({
      createFeeCollectionInvoice,
      getUserWallet,
      insertDonation,
      log: {error: mock(() => {}), info: mock(() => {}), debug: mock(() => {})} as never,
      ...overrides,
      pending,
      issuance,
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
  for (const error of [new InsufficientFundsError()]) {
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
      expect(insertDonation).not.toHaveBeenCalled()
      expect(payInvoice).toHaveBeenCalledTimes(2)
      expect(createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    })
  }
}

for (const error of [
  new NWCPaymentFailedError(),
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
      attemptId: null,
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
      attemptId: null,
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
    expect(reconcileUser).toHaveBeenCalledWith(1, 'one_shot', undefined, [])
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
        pendingRows.push({...row, attemptId: row.attemptId ?? null, createdAt: new Date()})
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
  expect(reconcileUser).toHaveBeenCalledWith(1, 'feature_request', undefined, [])
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'feature_request',
      amountSats: 21,
      paymentHash: 'fee-21',
      expiresAt: expect.any(Date),
    }),
  )
})

for (const pendingKind of ['one_shot', 'feature_request'] as const) {
  test(`parallel paid recovery shares one promise and ledger row: ${pendingKind}`, async () => {
    const h = donationPayHarness()
    const attemptId = pendingKind === 'feature_request' ? 'attempt-a' : undefined
    await h.save('previous', attemptId)
    h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
    const input = {userId: 1, amountSats: 50, kind: 'one_shot' as const, pendingKind, attemptId}
    const first = h.service.payDonation(input)
    const second = h.service.payDonation(input)
    expect(first).toBe(second)
    const results = await Promise.all([first, second])
    expect(results[0]).toBe(results[1])
    expect(results[0]).toMatchObject({status: 'paid', rail: 'recovered', paymentHash: 'previous'})
    expect(h.ledger.size).toBe(1)
    expect(h.completePending).toHaveBeenCalledTimes(1)
    expect(h.createFeeCollectionInvoice).not.toHaveBeenCalled()
    expect(h.payInvoice).not.toHaveBeenCalled()
  })
}

for (const initial of ['empty', 'expired'] as const) {
  test(`parallel ${initial} retries mint and debit once; a later new donation still works`, async () => {
    const h = donationPayHarness()
    if (initial === 'expired') await h.save('old', null, new Date(Date.now() - 1000))
    const input = {userId: 1, amountSats: 50, kind: 'one_shot' as const}
    const results = await Promise.all([h.service.payDonation(input), h.service.payDonation(input)])
    expect(results[0]).toBe(results[1])
    expect(results[0]).toMatchObject({status: 'paid', paymentHash: 'new-1'})
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
    expect(h.payInvoice).toHaveBeenCalledTimes(1)
    expect(h.ledger.size).toBe(1)
    expect(h.rows.size).toBe(0)
    expect(await h.service.payDonation(input)).toMatchObject({status: 'paid', paymentHash: 'new-2'})
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    expect(h.ledger.size).toBe(2)
  })
}

for (const paid of [false, true]) {
  test(`the re-read immediately before mint detects a newly installed ${paid ? 'paid' : 'pending'} invoice`, async () => {
    const h = donationPayHarness()
    const reconcileUser = h.pending.reconcileUser
    let calls = 0
    h.deps.pending = {
      ...h.pending,
      reconcileUser: async (...args) => {
        if (++calls === 2) await h.save('raced')
        return reconcileUser(...args)
      },
    }
    h.lookupFeePayment.mockResolvedValue({paid, details: {amount: 50_000}})
    const service = createDonationPayService(h.deps)
    expect(await service.payDonation({userId: 1, amountSats: 50, kind: 'one_shot'})).toMatchObject({
      status: paid ? 'paid' : 'pending',
      paymentHash: 'raced',
    })
    expect(calls).toBe(2)
    expect(h.createFeeCollectionInvoice).not.toHaveBeenCalled()
    expect(h.payInvoice).not.toHaveBeenCalled()
    expect(h.ledger.size).toBe(paid ? 1 : 0)
  })
}

for (const outcome of ['paid', 'live', 'ttl', 'invoice_expired', 'failed', '404'] as const) {
  test(`NWC Could not pay preserves fee hash, then reconciles ${outcome} before any new debit`, async () => {
    const h = donationPayHarness()
    h.uncertain()
    const input = {
      userId: 1,
      amountSats: 50,
      kind: 'one_shot' as const,
      rail: 'nwc' as const,
      nwc: {payInvoice: h.payInvoice} as never,
    }
    const before = Date.now()
    expect(await h.service.payDonation(input)).toMatchObject({
      status: 'pending',
      paymentHash: 'new-1',
    })
    const row = h.rows.get('new-1')
    if (!row) throw new Error('Missing pending invoice')
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(86_400_000)
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000)
    if (outcome === 'paid') {
      row.expiresAt = new Date(Date.now() - 1000)
      h.lookupFeePayment.mockResolvedValue({
        paid: true,
        details: {amount: 50_000, expiry: row.expiresAt},
      })
    }
    if (outcome === 'ttl') row.expiresAt = new Date(Date.now() - 1000)
    if (outcome === 'invoice_expired')
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        details: {amount: 50_000, expiry: new Date(Date.now() - 1000)},
      })
    if (outcome === 'failed')
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        status: 'failed',
        details: {amount: 50_000},
      })
    if (outcome === '404')
      h.lookupFeePayment.mockRejectedValue(
        Object.assign(Object.create(HTTPError.prototype), {response: {statusCode: 404}}),
      )
    const result = await h.service.payDonation(input)
    const retryable = !['paid', 'live'].includes(outcome)
    expect(result).toMatchObject({
      status: outcome === 'paid' ? 'paid' : 'pending',
      paymentHash: retryable ? 'new-2' : 'new-1',
    })
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(retryable ? 2 : 1)
    expect(h.payInvoice).toHaveBeenCalledTimes(retryable ? 2 : 1)
    expect(h.lookupFeePayment).toHaveBeenCalledWith('new-1')
    expect(h.ledger.size).toBe(outcome === 'paid' ? 1 : 0)
    await h.pending.reconcileAll()
    expect(h.ledger.size).toBe(outcome === 'paid' ? 1 : 0)
  })
}

test('insufficient NWC funds release pending and the issuance slot without retaining a hash', async () => {
  const h = donationPayHarness()
  h.insufficient()
  const result = await h.service.payDonation({
    userId: 1,
    amountSats: 50,
    kind: 'one_shot',
    rail: 'nwc',
    nwc: {payInvoice: h.payInvoice} as never,
  })
  expect(result).toMatchObject({status: 'failed', reason: 'pay_failed'})
  expect(result).not.toHaveProperty('paymentHash')
  expect(h.rows.size).toBe(0)
  expect(h.slots.size).toBe(0)
  expect(h.ledger.size).toBe(0)
})

test('a second service cannot mint while another process owns the issuance slot', async () => {
  const h = donationPayHarness()
  const other = createDonationPayService(h.deps)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let started!: () => void
  const entered = new Promise<void>(resolve => {
    started = resolve
  })
  h.createFeeCollectionInvoice.mockImplementation(async () => {
    started()
    await gate
    return {payment_hash: 'shared', bolt11: 'invoice'}
  })
  const input = {userId: 1, amountSats: 50, kind: 'one_shot' as const}
  const first = h.service.payDonation(input)
  await entered
  const second = await other.payDonation(input)
  expect(second.status).toBe('failed')
  release()
  expect(await first).toMatchObject({status: 'paid', paymentHash: 'shared'})
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
  expect(h.ledger.size).toBe(1)
})
