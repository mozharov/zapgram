import {expect, mock, test} from 'bun:test'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {MONTHLY_DONATION_PERIOD_MS} from '@core/money/donation.js'
import type {Donation, User} from '@infra/db/types.js'
import {HTTPError} from 'got'
import {createDonationPayService, type DonationPayDeps} from '../pay.service.js'
import {type MonthlyDonationDeps, processMonthlyDonation} from './process-monthly-donations.js'

function harness() {
  const now = new Date()
  const user = {
    id: 1,
    monthlyDonationSats: 50,
    monthlyDonationNextAt: new Date(now.getTime() - 1000),
    monthlyDonationLastHash: null,
    monthlyDonationLastFailNotifyAt: null,
    languageCode: 'en',
    nwcUrl: null,
  } as User
  const ledger: Donation[] = []
  const insertDonation = mock(async (input: Parameters<DonationPayDeps['insertDonation']>[0]) => {
    const row: Donation = {
      ...input,
      id: crypto.randomUUID(),
      paymentHash: input.paymentHash ?? null,
      attemptId: null,
      createdAt: new Date(),
    }
    ledger.push(row)
    return row
  })
  const log = {error: mock(() => {}), info: mock(() => {}), debug: mock(() => {})} as never
  const payInvoice = mock(async (): Promise<{payment_hash?: string}> => {
    throw new PaymentPendingError()
  })
  const createFeeCollectionInvoice = mock(
    async (): Promise<{payment_hash: string; bolt11: string}> => ({
      payment_hash: `fee-${createFeeCollectionInvoice.mock.calls.length}`,
      bolt11: 'unit-test-invoice',
    }),
  )
  const donationPay = createDonationPayService({
    pending: {
      save: async () => {},
      reconcileUser: async () => [],
      complete: async () => {},
      remove: async () => {},
    },
    issuance: {
      reserveIssuance: async () => null,
      releaseIssuance: async () => {},
      saveIssued: async () => false,
    },
    createFeeCollectionInvoice,
    getUserWallet: async () => ({balance: 100_000, payInvoice}),
    insertDonation,
    log,
  })
  const payDonation = mock(donationPay.payDonation)
  const lookupFeePayment = mock(
    async (): Promise<{
      paid: boolean
      status?: string
      details: {amount: number; expiry?: Date | null}
    }> => ({
      paid: false,
      status: 'pending',
      details: {amount: 50_000},
    }),
  )
  const send = mock(async () => true)
  const update = mock(async (_id: number, data: Partial<User>) => Object.assign(user, data))
  const deps: MonthlyDonationDeps = {
    log,
    posthog: undefined,
    users: {update},
    donations: {
      insertDonation,
      findByPaymentHash: async hash => ledger.find(row => row.paymentHash === hash),
    },
    donationPay: {payDonation},
    masterWallet: {lookupFeePayment},
    notifier: {send},
    rates: {getBtcUsd: async () => null},
    translate: key => key,
  }
  const tick = (time = now) => processMonthlyDonation(deps, {...user}, time)
  return {
    deps,
    user,
    now,
    tick,
    ledger,
    insertDonation,
    update,
    createFeeCollectionInvoice,
    payInvoice,
    payDonation,
    lookupFeePayment,
    send,
  }
}

test('unknown pay saves its hash; pending lookups never create or pay another invoice', async () => {
  const h = harness()
  const dueAt = h.user.monthlyDonationNextAt
  expect(await h.tick()).toBe('keep')
  const hash = h.user.monthlyDonationLastHash
  expect(hash).toBeTruthy()
  expect(h.user.monthlyDonationNextAt).toEqual(dueAt)
  expect(h.ledger).toHaveLength(0)

  for (const lookup of [
    {paid: false, status: 'pending', details: {amount: 50_000}},
    {paid: false, details: {amount: 50_000}},
  ]) {
    h.lookupFeePayment.mockResolvedValue(lookup)
    expect(await h.tick()).toBe('keep')
  }
  expect(h.lookupFeePayment).toHaveBeenCalledTimes(2)
  expect(h.lookupFeePayment).toHaveBeenCalledWith(hash)
  expect(h.user.monthlyDonationLastHash).toBe(hash)
  expect(h.user.monthlyDonationNextAt).toEqual(dueAt)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
  expect(h.payDonation).toHaveBeenCalledTimes(1)
  expect(h.insertDonation).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
})

test('unknown then paid records the ledger and advances the period without paying again', async () => {
  const h = harness()
  await h.tick()
  const hash = h.user.monthlyDonationLastHash
  h.lookupFeePayment.mockResolvedValue({paid: true, status: 'success', details: {amount: 50_000}})
  const later = new Date(h.now.getTime() + 60 * 60 * 1000)
  expect(await h.tick(later)).toBe('done')
  expect(h.user.monthlyDonationNextAt?.getTime()).toBe(later.getTime() + MONTHLY_DONATION_PERIOD_MS)
  expect(h.user.monthlyDonationLastHash).toBeNull()
  expect(h.ledger).toEqual([
    expect.objectContaining({
      userId: 1,
      amountSats: 50,
      kind: 'monthly',
      paymentHash: hash,
    }),
  ])
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
  expect(h.payDonation).toHaveBeenCalledTimes(1)
  expect(h.insertDonation).toHaveBeenCalledTimes(1)
  expect(h.send).not.toHaveBeenCalled()
})

test('unknown then definitively failed allows a fresh invoice and payment attempt', async () => {
  const h = harness()
  await h.tick()
  const oldHash = h.user.monthlyDonationLastHash
  h.lookupFeePayment.mockResolvedValue({paid: false, status: 'failed', details: {amount: 50_000}})
  expect(await h.tick()).toBe('keep')
  expect(h.user.monthlyDonationLastHash).toBeTruthy()
  expect(h.user.monthlyDonationLastHash).not.toBe(oldHash)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
  expect(h.payInvoice).toHaveBeenCalledTimes(2)
  expect(h.payDonation).toHaveBeenCalledTimes(2)
  expect(h.insertDonation).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
})

test('a successful retry clears the hash so the next due period can be charged', async () => {
  const h = harness()
  await h.tick()
  h.lookupFeePayment.mockResolvedValue({paid: false, status: 'failed', details: {amount: 50_000}})
  h.payInvoice.mockResolvedValue({})
  expect(await h.tick()).toBe('done')
  expect(h.ledger).toHaveLength(1)
  expect(h.user.monthlyDonationLastHash).toBeNull()
  const nextDue = h.user.monthlyDonationNextAt
  if (!nextDue) throw new Error('Expected a next period')
  expect(await h.tick(nextDue)).toBe('done')
  expect(h.lookupFeePayment).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(3)
  expect(h.payInvoice).toHaveBeenCalledTimes(3)
  expect(h.insertDonation).toHaveBeenCalledTimes(2)
  expect(h.ledger).toHaveLength(2)
  expect(h.user.monthlyDonationNextAt?.getTime()).toBe(
    nextDue.getTime() + MONTHLY_DONATION_PERIOD_MS,
  )
  expect(h.send).not.toHaveBeenCalled()
})

function httpError(statusCode: number): HTTPError {
  return Object.assign(Object.create(HTTPError.prototype) as HTTPError, {
    response: {statusCode},
  })
}

test('a definitive lookup 404 permits a new invoice', async () => {
  const h = harness()
  await h.tick()
  const oldHash = h.user.monthlyDonationLastHash
  h.lookupFeePayment.mockRejectedValue(httpError(404))
  expect(await h.tick()).toBe('keep')
  expect(h.user.monthlyDonationLastHash).not.toBe(oldHash)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
  expect(h.payInvoice).toHaveBeenCalledTimes(2)
  expect(h.payDonation).toHaveBeenCalledTimes(2)
  expect(h.insertDonation).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
})

for (const error of [new Error('timeout'), httpError(401), httpError(500)]) {
  test(`lookup error (${error instanceof HTTPError ? error.response.statusCode : error.message}) waits without another payment`, async () => {
    const h = harness()
    await h.tick()
    const hash = h.user.monthlyDonationLastHash
    const dueAt = h.user.monthlyDonationNextAt
    h.lookupFeePayment.mockRejectedValue(error)
    expect(await h.tick()).toBe('keep')
    expect(h.user.monthlyDonationLastHash).toBe(hash)
    expect(h.user.monthlyDonationNextAt).toEqual(dueAt)
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
    expect(h.payInvoice).toHaveBeenCalledTimes(1)
    expect(h.payDonation).toHaveBeenCalledTimes(1)
    expect(h.insertDonation).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
}

test('recovery after a failed schedule write does not duplicate the ledger', async () => {
  const h = harness()
  await h.tick()
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  h.update.mockRejectedValueOnce(new Error('db temporarily unavailable'))
  await expect(h.tick()).rejects.toThrow('db temporarily unavailable')
  expect(h.ledger).toHaveLength(1)
  expect(await h.tick()).toBe('done')
  expect(h.ledger).toHaveLength(1)
  expect(h.insertDonation).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
})

test('a recovered invoice clears its hash so the next due period is charged', async () => {
  const h = harness()
  await h.tick()
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  expect(await h.tick()).toBe('done')
  const nextDue = h.user.monthlyDonationNextAt
  if (!nextDue) throw new Error('Expected a next period')
  h.payInvoice.mockResolvedValue({})
  expect(await h.tick(nextDue)).toBe('done')
  expect(h.lookupFeePayment).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
  expect(h.payInvoice).toHaveBeenCalledTimes(2)
  expect(h.ledger.map(row => row.amountSats)).toEqual([50, 50])
  expect(h.user.monthlyDonationLastHash).toBeNull()
})

test('disabled donor keeps a pending invoice, then records its actual paid amount only once', async () => {
  const h = harness()
  await h.tick()
  const hash = h.user.monthlyDonationLastHash
  h.user.monthlyDonationSats = 0
  h.user.monthlyDonationNextAt = null
  expect(await h.tick()).toBe('keep')
  expect(h.user.monthlyDonationLastHash).toBe(hash)
  expect(h.insertDonation).not.toHaveBeenCalled()

  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  // A failed hash-clear write must not insert the same donation twice on the next tick.
  h.update.mockRejectedValueOnce(new Error('db temporarily unavailable'))
  await expect(h.tick()).rejects.toThrow('db temporarily unavailable')
  expect(await h.tick()).toBe('done')
  expect(await h.tick()).toBe('done')
  expect(h.user.monthlyDonationSats).toBe(0)
  expect(h.user.monthlyDonationNextAt).toBeNull()
  expect(h.user.monthlyDonationLastHash).toBeNull()
  expect(h.ledger).toEqual([
    expect.objectContaining({amountSats: 50, kind: 'monthly', paymentHash: hash}),
  ])
  expect(h.insertDonation).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
  expect(h.payDonation).toHaveBeenCalledTimes(1)
  expect(h.send).not.toHaveBeenCalled()
})

for (const outcome of ['failed', '404'] as const) {
  test(`disabled donor clears a ${outcome} hash without creating another invoice`, async () => {
    const h = harness()
    await h.tick()
    h.user.monthlyDonationSats = 0
    h.user.monthlyDonationNextAt = null
    if (outcome === '404') h.lookupFeePayment.mockRejectedValue(httpError(404))
    else
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        status: 'failed',
        details: {amount: 50_000},
      })
    expect(await h.tick()).toBe('done')
    expect(await h.tick()).toBe('done')
    expect(h.user.monthlyDonationSats).toBe(0)
    expect(h.user.monthlyDonationNextAt).toBeNull()
    expect(h.user.monthlyDonationLastHash).toBeNull()
    expect(h.lookupFeePayment).toHaveBeenCalledTimes(1)
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
    expect(h.payInvoice).toHaveBeenCalledTimes(1)
    expect(h.payDonation).toHaveBeenCalledTimes(1)
    expect(h.insertDonation).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
}

for (const source of ['lookup', 'saved'] as const) {
  test(`pending monthly ${source} expiry releases the hash and allows a new invoice`, async () => {
    const h = harness()
    await h.tick()
    const oldHash = h.user.monthlyDonationLastHash
    const expired = new Date(h.now.getTime() - 1000)
    if (source === 'lookup')
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        status: 'pending',
        details: {amount: 50_000, expiry: expired},
      })
    else h.user.monthlyDonationExpiresAt = expired
    h.payInvoice.mockResolvedValue({})
    expect(await h.tick()).toBe('done')
    expect(h.user.monthlyDonationLastHash).toBeNull()
    expect(h.user.monthlyDonationExpiresAt).toBeNull()
    expect(h.update).toHaveBeenCalledWith(1, {
      monthlyDonationLastHash: null,
      monthlyDonationExpiresAt: null,
    })
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(2)
    expect(h.ledger).toHaveLength(1)
    expect(h.ledger[0]?.paymentHash).not.toBe(oldHash)
  })
}

test('pending with live lookup and saved expiry waits without a new invoice', async () => {
  const h = harness()
  await h.tick()
  const hash = h.user.monthlyDonationLastHash
  expect(h.user.monthlyDonationExpiresAt).toBeInstanceOf(Date)
  h.lookupFeePayment.mockResolvedValue({
    paid: false,
    details: {amount: 50_000, expiry: new Date(h.now.getTime() + 60_000)},
  })
  expect(await h.tick()).toBe('keep')
  expect(h.user.monthlyDonationLastHash).toBe(hash)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
})

for (const future of [false, true]) {
  test(`NWC refusal retains lastHash and recovers real debit once (future nextAt: ${future})`, async () => {
    const h = harness()
    const payInvoice = mock(async () => {
      throw new NWCPaymentFailedError()
    })
    h.user.nwcUrl = 'unit-test-nwc'
    h.deps.donationPay = createDonationPayService({
      pending: {
        save: async () => {},
        reconcileUser: async () => [],
        complete: async () => {},
        remove: async () => {},
      },
      issuance: {
        reserveIssuance: async () => null,
        releaseIssuance: async () => {},
        saveIssued: async () => false,
      },
      createFeeCollectionInvoice: h.createFeeCollectionInvoice,
      getUserWallet: async () => ({balance: 0, payInvoice}),
      createNwc: () => ({payInvoice}) as never,
      insertDonation: h.insertDonation,
      log: h.deps.log,
    })
    expect(await h.tick()).toBe('keep')
    const hash = h.user.monthlyDonationLastHash
    expect(hash).toBeTruthy()
    expect(h.user.monthlyDonationExpiresAt).toBeInstanceOf(Date)
    expect(await h.tick()).toBe('keep')
    if (future)
      h.user.monthlyDonationNextAt = new Date(h.now.getTime() + MONTHLY_DONATION_PERIOD_MS)
    const nextAt = h.user.monthlyDonationNextAt
    h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
    expect(await h.tick()).toBe('done')
    expect(await h.tick()).toBe('done')
    expect(h.user.monthlyDonationLastHash).toBeNull()
    expect(h.user.monthlyDonationExpiresAt).toBeNull()
    expect(h.user.monthlyDonationNextAt).toEqual(
      future ? nextAt : new Date(h.now.getTime() + MONTHLY_DONATION_PERIOD_MS),
    )
    expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(h.ledger).toEqual([expect.objectContaining({paymentHash: hash, kind: 'monthly'})])
  })
}

test('paid recovery preserves a future nextAt and clears hash and TTL without charging', async () => {
  const h = harness()
  await h.tick()
  h.user.monthlyDonationNextAt = new Date(h.now.getTime() + MONTHLY_DONATION_PERIOD_MS)
  const nextAt = h.user.monthlyDonationNextAt
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  expect(await h.tick()).toBe('done')
  expect(h.user.monthlyDonationNextAt).toEqual(nextAt)
  expect(h.user.monthlyDonationLastHash).toBeNull()
  expect(h.user.monthlyDonationExpiresAt).toBeNull()
  expect(await h.tick()).toBe('done')
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.ledger).toHaveLength(1)
})

test('paid recovery schedules an enabled donor with null nextAt', async () => {
  const h = harness()
  h.user.monthlyDonationLastHash = 'old-success'
  h.user.monthlyDonationNextAt = null
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  expect(await h.tick()).toBe('done')
  expect((h.user.monthlyDonationNextAt as Date | null)?.getTime()).toBe(
    h.now.getTime() + MONTHLY_DONATION_PERIOD_MS,
  )
  expect(h.user.monthlyDonationLastHash).toBeNull()
  expect(h.ledger).toHaveLength(1)
  expect(h.createFeeCollectionInvoice).not.toHaveBeenCalled()
})

test('legacy pending without lookup expiry gets a stored TTL once and eventually retries', async () => {
  const h = harness()
  h.user.monthlyDonationLastHash = 'legacy-pending'
  h.user.monthlyDonationExpiresAt = null
  expect(await h.tick()).toBe('keep')
  const expiresAt = h.user.monthlyDonationExpiresAt as Date | null
  if (!expiresAt) throw new Error('Expected stored TTL')
  expect(await h.tick(new Date(h.now.getTime() + 1000))).toBe('keep')
  expect(h.user.monthlyDonationExpiresAt as Date | null).toEqual(expiresAt)
  h.payInvoice.mockResolvedValue({})
  expect(await h.tick(new Date(expiresAt.getTime() + 1000))).toBe('done')
  expect(h.user.monthlyDonationLastHash).toBeNull()
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
})
