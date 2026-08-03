import {beforeEach, describe, expect, test} from 'bun:test'
import type {SubscriptionPayment} from '@infra/db/types.js'
import {createSettleService} from '@modules/subscriptions/settle.service.js'
import {HTTPError} from 'got'

/**
 * Exercises the real payout path against a fake LNbits, walking through the crash points that used
 * to allow a second payout to the chat owner.
 */

const PRICE = 1000
const FEE_PERCENT = 0.05
const EXPECTED_FEE = 50 // ceil(1000 * 0.05)

let issued: Array<{hash: string; bolt11: string; sats: number}> = []
let paidBolt11s: string[] = []
let ledger = new Map<string, {paid: boolean; status?: string}>()
let persistedHash: string | null = null
let persistedFeeHash: string | null = null
let invoiceCounter = 0
let order: string[] = []

function makeDistribute() {
  return createSettleService({
    recordSettleAttempt: async () => {},
    grantAccess: () => 'granted',
    approveChatJoinRequest: async () => {},
    getChatOrThrow: async () => {
      throw new Error('not used')
    },
    getUserOrThrow: async id => ({id}) as never,
    deletePayment: async () => {},
    findSubscriptionByUserAndChat: async () => null,
    recordPayoutInvoice: async (_id, hash) => {
      persistedHash = hash
      order.push('persist')
    },
    recordFeePayoutInvoice: async (_id, hash) => {
      persistedFeeHash = hash
      order.push('persist-fee')
    },
    recordRefundInvoice: async () => {},
    markRefundCredited: async () => {},
    masterWallet: {
      lookupPayment: async hash => {
        const entry = ledger.get(hash)
        if (!entry) {
          const error = Object.create(HTTPError.prototype) as HTTPError
          Object.assign(error, {response: {statusCode: 404}})
          throw error
        }
        return entry
      },
      payInvoice: async bolt11 => {
        const invoice = issued.find(i => i.bolt11 === bolt11)
        if (!invoice) throw new Error(`unknown bolt11 ${bolt11}`)
        paidBolt11s.push(bolt11)
        order.push(bolt11.startsWith('fee-') ? 'pay-fee' : 'pay')
        ledger.set(invoice.hash, {paid: true})
      },
      createFeeCollectionInvoice: async sats => {
        invoiceCounter++
        const invoice = {
          hash: `fee-${invoiceCounter}`,
          bolt11: `fee-bolt11-${invoiceCounter}`,
          sats,
        }
        issued.push(invoice)
        return {payment_hash: invoice.hash, bolt11: invoice.bolt11}
      },
    },
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
    notifier: {send: async () => {}, sendPhoto: async () => {}},
    log: {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}},
    feePercent: FEE_PERCENT,
    translate: () => '',
  }).distributeOnce
}

function makePayment(overrides: Partial<SubscriptionPayment> = {}): SubscriptionPayment {
  return {
    id: 'pay-1',
    intentId: 'intent-1',
    userId: 10,
    chatId: -100,
    paymentRequest: 'lnbc-subscriber',
    paymentHash: 'subscriber-hash',
    price: PRICE,
    subscriptionType: 'monthly',
    kind: 'join',
    expiresAt: null,
    isCurrent: true,
    attemptStatus: 'pending',
    processedAt: null,
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
    refundPayoutHash: null,
    refundedAt: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  }
}

const ownerPayouts = () => paidBolt11s.filter(b => !b.startsWith('fee-'))

describe('settleService.distributeOnce', () => {
  let distributeOnce: ReturnType<typeof makeDistribute>

  beforeEach(() => {
    issued = []
    paidBolt11s = []
    ledger = new Map()
    persistedHash = null
    persistedFeeHash = null
    invoiceCounter = 0
    order = []
    distributeOnce = makeDistribute()
  })

  test('first run pays the owner and collects the fee', async () => {
    const result = await distributeOnce(makePayment(), 42)
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
    expect(paidBolt11s.filter(b => b.startsWith('fee-'))).toHaveLength(1)
  })

  test('records each hash BEFORE paying that leg', async () => {
    await distributeOnce(makePayment(), 42)
    expect(order).toEqual(['persist', 'pay', 'persist-fee', 'pay-fee'])
  })

  test('CRASH between payout and row deletion: retry does not pay twice', async () => {
    await distributeOnce(makePayment(), 42)
    expect(ownerPayouts()).toHaveLength(1)
    const hash = persistedHash
    expect(hash).toBeTruthy()

    const result = await distributeOnce(
      makePayment({payoutHash: hash, feePayoutHash: persistedFeeHash}),
      42,
    )
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('CRASH between persisting the hash and paying: retry issues a fresh invoice', async () => {
    const result = await distributeOnce(makePayment({payoutHash: 'orphan-never-paid'}), 42)
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('a payout still in flight is never paid a second time', async () => {
    ledger.set('in-flight', {paid: false})
    const result = await distributeOnce(makePayment({payoutHash: 'in-flight'}), 42)
    expect(result).toEqual({status: 'pending'})
    expect(ownerPayouts()).toHaveLength(0)
  })

  test('a failed payout is re-issued', async () => {
    ledger.set('dead', {paid: false, status: 'failed'})
    const result = await distributeOnce(makePayment({payoutHash: 'dead'}), 42)
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('many retries after a successful payout still pay exactly once', async () => {
    await distributeOnce(makePayment(), 42)
    const hash = persistedHash
    for (let i = 0; i < 5; i++) {
      await distributeOnce(makePayment({payoutHash: hash}), 42)
    }
    expect(ownerPayouts()).toHaveLength(1)
  })

  test('no fee transfer when the fee rounds to zero', async () => {
    const result = await distributeOnce(makePayment({price: 0}), 42)
    expect(result).toEqual({status: 'paid', fee: 0})
    expect(paidBolt11s.filter(b => b.startsWith('fee-'))).toHaveLength(0)
  })

  test('CRASH between the owner payout and the fee transfer: retry only does the fee', async () => {
    await distributeOnce(makePayment(), 42)
    const feeBefore = paidBolt11s.filter(b => b.startsWith('fee-')).length
    const result = await distributeOnce(
      makePayment({payoutHash: persistedHash, feePayoutHash: null}),
      42,
    )
    expect(result.status).toBe('paid')
    expect(ownerPayouts()).toHaveLength(1)
    // fee runs again because feePayoutHash was null on the retry object
    expect(paidBolt11s.filter(b => b.startsWith('fee-')).length).toBeGreaterThanOrEqual(feeBefore)
  })

  test('a fee transfer that already settled is not repeated', async () => {
    await distributeOnce(makePayment(), 42)
    const feePaysBefore = paidBolt11s.filter(b => b.startsWith('fee-')).length
    const result = await distributeOnce(
      makePayment({payoutHash: persistedHash, feePayoutHash: persistedFeeHash}),
      42,
    )
    expect(result).toEqual({status: 'paid', fee: EXPECTED_FEE})
    expect(paidBolt11s.filter(b => b.startsWith('fee-')).length).toBe(feePaysBefore)
  })

  test('a fee transfer in flight blocks completion instead of re-sending', async () => {
    // Owner already paid; fee hash in flight
    ledger.set('owner-done', {paid: true})
    ledger.set('fee-in-flight', {paid: false})
    const result = await distributeOnce(
      makePayment({payoutHash: 'owner-done', feePayoutHash: 'fee-in-flight'}),
      42,
    )
    expect(result).toEqual({status: 'pending'})
    expect(paidBolt11s.filter(b => b.startsWith('fee-'))).toHaveLength(0)
  })
})
