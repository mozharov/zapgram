import {beforeEach, describe, expect, mock, test} from 'bun:test'
import type {SubscriptionPayment} from '@infra/db/types.js'
import {HTTPError} from 'got'

/**
 * Exercises the real payout path against a fake LNbits, walking through the crash points that used
 * to allow a second payout to the chat owner.
 */

const PRICE = 1000
const FEE_PERCENT = 0.05
const EXPECTED_FEE = 50 // ceil(1000 * 0.05)

/** Invoices the owner's wallet has issued, by hash. */
let issued: Array<{hash: string; bolt11: string; sats: number}> = []
/** bolt11s the master wallet actually paid — the thing that must never contain a duplicate. */
let paidBolt11s: string[] = []
/** Fake LNbits view of master-wallet payments, keyed by the hash of the invoice it paid. */
let ledger = new Map<string, {paid: boolean; status?: string}>()
/** What recordPayoutInvoice / recordFeePayoutInvoice persisted. */
let persistedHash: string | null = null
let persistedFeeHash: string | null = null
let invoiceCounter = 0
/** Sequence of side effects, used to assert the persist-before-pay ordering. */
let order: string[] = []

mock.module('@config', () => ({config: {SUBSCRIPTION_FEE_PERCENT: FEE_PERCENT}}))
mock.module('@infra/logger.js', () => ({
  logger: {info: () => {}, error: () => {}, debug: () => {}, warn: () => {}},
}))
mock.module('../models/user.js', () => ({getUserOrThrow: async (id: number) => ({id})}))
mock.module('../models/subscription-payment.js', () => ({
  recordPayoutInvoice: async (_id: string, hash: string) => {
    persistedHash = hash
    order.push('persist')
  },
  recordFeePayoutInvoice: async (_id: string, hash: string) => {
    persistedFeeHash = hash
    order.push('persist-fee')
  },
}))
mock.module('./lnbits-user-wallet.js', () => ({
  getUserWallet: async () => ({
    createInvoice: async ({sats}: {sats: number}) => {
      invoiceCounter++
      const invoice = {
        hash: `hash-${invoiceCounter}`,
        bolt11: `bolt11-${invoiceCounter}`,
        sats,
      }
      issued.push(invoice)
      return {payment_hash: invoice.hash, bolt11: invoice.bolt11}
    },
  }),
}))
mock.module('@infra/lnbits/master-wallet.js', () => ({
  lnbitsMasterWallet: {
    lookupPayment: async (hash: string) => {
      const entry = ledger.get(hash)
      if (!entry) {
        // Mirrors LNbits 1.5.6: unknown hash → 404 "Payment does not exist."
        const error = Object.create(HTTPError.prototype) as HTTPError
        Object.assign(error, {response: {statusCode: 404}})
        throw error
      }
      return entry
    },
    payInvoice: async (bolt11: string) => {
      const invoice = issued.find(i => i.bolt11 === bolt11)
      if (!invoice) throw new Error(`unknown bolt11 ${bolt11}`)
      paidBolt11s.push(bolt11)
      order.push(bolt11.startsWith('fee-') ? 'pay-fee' : 'pay')
      ledger.set(invoice.hash, {paid: true})
    },
    createFeeCollectionInvoice: async (sats: number) => {
      invoiceCounter++
      const invoice = {hash: `fee-${invoiceCounter}`, bolt11: `fee-bolt11-${invoiceCounter}`, sats}
      issued.push(invoice)
      return {payment_hash: invoice.hash, bolt11: invoice.bolt11}
    },
  },
}))

const {distributeSubscriptionPaymentOnce} = await import('./subscription-payment.js')

function makePayment(overrides: Partial<SubscriptionPayment> = {}): SubscriptionPayment {
  return {
    id: 'pay-1',
    userId: 10,
    chatId: -100,
    paymentRequest: 'lnbc-subscriber',
    paymentHash: 'subscriber-hash',
    price: PRICE,
    subscriptionType: 'monthly',
    kind: 'join',
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  }
}

/** Payouts to the owner, excluding the internal fee-collection transfer. */
const ownerPayouts = () => paidBolt11s.filter(b => !b.startsWith('fee-'))

describe('distributeSubscriptionPaymentOnce', () => {
  beforeEach(() => {
    issued = []
    paidBolt11s = []
    ledger = new Map()
    persistedHash = null
    persistedFeeHash = null
    invoiceCounter = 0
    order = []
  })

  /** The internal master → fee-collection transfer. */
  const feeTransfers = () => paidBolt11s.filter(b => b.startsWith('fee-'))

  test('first run pays the owner and collects the fee', async () => {
    const result = await distributeSubscriptionPaymentOnce(makePayment(), 42)
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
    expect(issued[0]?.sats).toBe(PRICE - EXPECTED_FEE)
    expect(paidBolt11s.filter(b => b.startsWith('fee-'))).toHaveLength(1)
  })

  test('records each hash BEFORE paying that leg', async () => {
    // The whole guarantee rests on this ordering: if a write landed after its payment, a crash in
    // between would leave a settled transfer that no retry could ever discover.
    await distributeSubscriptionPaymentOnce(makePayment(), 42)
    expect(order).toEqual(['persist', 'pay', 'persist-fee', 'pay-fee'])
    expect(persistedHash).toBe(issued[0]?.hash ?? null)
    expect(persistedFeeHash).toBe(issued[1]?.hash ?? null)
  })

  test('CRASH between payout and row deletion: retry does not pay twice', async () => {
    // Attempt 1 completes the payout, then the process dies before the row is deleted.
    await distributeSubscriptionPaymentOnce(makePayment(), 42)
    expect(ownerPayouts()).toHaveLength(1)
    const hashFromAttempt1 = persistedHash

    // Attempt 2 sees the persisted hash and asks LNbits, which reports it settled.
    const result = await distributeSubscriptionPaymentOnce(
      makePayment({payoutHash: hashFromAttempt1}),
      42,
    )
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1) // still one — no double payout
  })

  test('CRASH between persisting the hash and paying: retry issues a fresh invoice', async () => {
    // Nothing was paid, so LNbits 404s on the stored hash and re-issuing is safe.
    const result = await distributeSubscriptionPaymentOnce(
      makePayment({payoutHash: 'hash-from-a-lost-attempt'}),
      42,
    )
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('a payout still in flight is never paid a second time', async () => {
    ledger.set('inflight', {paid: false})
    const result = await distributeSubscriptionPaymentOnce(
      makePayment({payoutHash: 'inflight'}),
      42,
    )
    expect(result).toEqual({status: 'pending'})
    expect(ownerPayouts()).toHaveLength(0)
  })

  test('a failed payout is re-issued', async () => {
    ledger.set('dead', {paid: false, status: 'failed'})
    const result = await distributeSubscriptionPaymentOnce(makePayment({payoutHash: 'dead'}), 42)
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('many retries after a successful payout still pay exactly once', async () => {
    await distributeSubscriptionPaymentOnce(makePayment(), 42)
    const hash = persistedHash
    for (let i = 0; i < 25; i++) {
      await distributeSubscriptionPaymentOnce(makePayment({payoutHash: hash}), 42)
    }
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('no fee transfer when the fee rounds to zero', async () => {
    const result = await distributeSubscriptionPaymentOnce(makePayment({price: 0}), 42)
    expect(result).toEqual({status: 'paid', fee: 0})
    expect(feeTransfers()).toHaveLength(0)
  })

  test('CRASH between the owner payout and the fee transfer: retry only does the fee', async () => {
    await distributeSubscriptionPaymentOnce(makePayment(), 42)
    const ownerHash = persistedHash

    // The row as it would look if the process died right after the owner payout: owner hash stored
    // and settled at LNbits, fee hash never written.
    const result = await distributeSubscriptionPaymentOnce(
      makePayment({payoutHash: ownerHash, feePayoutHash: null}),
      42,
    )
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1) // owner not paid again
    expect(feeTransfers()).toHaveLength(2) // fee ran on both passes — see next test for the guard
  })

  test('a fee transfer that already settled is not repeated', async () => {
    await distributeSubscriptionPaymentOnce(makePayment(), 42)
    const [ownerHash, feeHash] = [persistedHash, persistedFeeHash]

    for (let i = 0; i < 10; i++) {
      const result = await distributeSubscriptionPaymentOnce(
        makePayment({payoutHash: ownerHash, feePayoutHash: feeHash}),
        42,
      )
      expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    }
    expect(ownerPayouts()).toHaveLength(1)
    expect(feeTransfers()).toHaveLength(1)
  })

  test('a fee transfer in flight blocks completion instead of re-sending', async () => {
    ledger.set('owner-done', {paid: true})
    ledger.set('fee-inflight', {paid: false})
    const result = await distributeSubscriptionPaymentOnce(
      makePayment({payoutHash: 'owner-done', feePayoutHash: 'fee-inflight'}),
      42,
    )
    expect(result).toEqual({status: 'pending'})
    expect(feeTransfers()).toHaveLength(0)
  })
})
