import {expect, mock, test} from 'bun:test'
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
    createFeeCollectionInvoice,
    getUserWallet: async () => ({balance: 100_000, payInvoice}),
    insertDonation,
    log,
  })
  const payDonation = mock(donationPay.payDonation)
  const lookupFeePayment = mock(
    async (): Promise<{paid: boolean; status?: string}> => ({
      paid: false,
      status: 'pending',
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

  for (const lookup of [{paid: false, status: 'pending'}, {paid: false}]) {
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
  h.lookupFeePayment.mockResolvedValue({paid: true, status: 'success'})
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
  h.lookupFeePayment.mockResolvedValue({paid: false, status: 'failed'})
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
  h.lookupFeePayment.mockResolvedValue({paid: false, status: 'failed'})
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
  h.lookupFeePayment.mockResolvedValue({paid: true})
  h.update.mockRejectedValueOnce(new Error('db temporarily unavailable'))
  await expect(h.tick()).rejects.toThrow('db temporarily unavailable')
  expect(h.ledger).toHaveLength(1)
  expect(await h.tick()).toBe('done')
  expect(h.ledger).toHaveLength(1)
  expect(h.insertDonation).toHaveBeenCalledTimes(1)
  expect(h.createFeeCollectionInvoice).toHaveBeenCalledTimes(1)
  expect(h.payInvoice).toHaveBeenCalledTimes(1)
})
