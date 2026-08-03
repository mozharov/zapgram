import {beforeEach, describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {translate} from '@telegram/i18n/i18n.js'
import {createTestDb} from '@test/helpers/db.js'
import {createFakeNotifier} from '@test/helpers/fakes/notifier.js'
import {HTTPError} from 'got'
import {createGrantSubscriptionAccess} from './access.js'
import {createSubscriptionIntentRepository} from './intent-repository.js'
import {createSubscriptionPaymentRepository, MAX_SETTLE_ATTEMPTS} from './payment-repository.js'
import {createSubscriptionRepository} from './repository.js'
import {createSettleService, type SettleServiceDeps} from './settle.service.js'

function silentLog() {
  return {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}}
}

describe('settle service (characterization)', () => {
  let db: ReturnType<typeof createTestDb>
  let payments: ReturnType<typeof createSubscriptionPaymentRepository>
  let intents: ReturnType<typeof createSubscriptionIntentRepository>
  let subscriptions: ReturnType<typeof createSubscriptionRepository>
  let users: ReturnType<typeof createUserRepository>
  let chats: ReturnType<typeof createChatRepository>
  let notifier: ReturnType<typeof createFakeNotifier>
  let ledger: Map<string, {paid: boolean; status?: string}>
  let paidBolt11s: string[]
  let invoiceSats: number[]
  let invoiceCounter: number
  let logErrors: string[]

  beforeEach(async () => {
    db = createTestDb()
    payments = createSubscriptionPaymentRepository(db)
    intents = createSubscriptionIntentRepository(db)
    subscriptions = createSubscriptionRepository(db)
    users = createUserRepository(db)
    chats = createChatRepository(db)
    notifier = createFakeNotifier()
    ledger = new Map()
    paidBolt11s = []
    invoiceSats = []
    invoiceCounter = 0
    logErrors = []

    await users.createOrUpdate({id: 1, languageCode: 'en', firstName: 'Owner', username: 'owner'})
    await users.createOrUpdate({id: 2, languageCode: 'en', firstName: 'Sub', username: 'sub'})
    await chats.createOrUpdate({
      id: -100,
      title: 'Test Community',
      type: 'supergroup',
      ownerId: 1,
      status: 'active',
      price: 1000,
      paymentType: 'monthly',
    })
  })

  function baseDeps(overrides: Partial<SettleServiceDeps> = {}): SettleServiceDeps {
    const log = silentLog()
    return {
      recordSettleAttempt: id => payments.recordSettleAttempt(id),
      claimPaidAttempt: (id, claimedAt) => payments.claimPaidAttempt(id, claimedAt),
      markWinnerCompleted: (id, processedAt) => payments.markWinnerCompleted(id, processedAt),
      grantAccess: createGrantSubscriptionAccess(db, log),
      approveChatJoinRequest: async () => {},
      getChatOrThrow: id => chats.getOrThrow(id),
      getUserOrThrow: id => users.getOrThrow(id),
      findSubscriptionByUserAndChat: (userId, chatId) =>
        subscriptions.findByUserAndChat(userId, chatId),
      recordPayoutInvoice: (id, hash) => payments.recordPayoutInvoice(id, hash),
      recordFeePayoutInvoice: (id, hash) => payments.recordFeePayoutInvoice(id, hash),
      recordRefundInvoice: (id, hash) => payments.recordRefundInvoice(id, hash),
      markRefundCredited: (id, refundedAt) => payments.markRefundCredited(id, refundedAt),
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
          paidBolt11s.push(bolt11)
          const ownerMatch = /bolt11-(\d+)/.exec(bolt11)
          if (ownerMatch) ledger.set(`hash-${ownerMatch[1]}`, {paid: true})
          const feeMatch = /fee-bolt11-(\d+)/.exec(bolt11)
          if (feeMatch) ledger.set(`fee-${feeMatch[1]}`, {paid: true})
        },
        createFeeCollectionInvoice: async () => {
          invoiceCounter++
          return {
            payment_hash: `fee-${invoiceCounter}`,
            bolt11: `fee-bolt11-${invoiceCounter}`,
          }
        },
      },
      getUserWallet: async () => ({
        createInvoice: async ({sats}) => {
          invoiceSats.push(sats)
          invoiceCounter++
          return {
            payment_hash: `hash-${invoiceCounter}`,
            bolt11: `bolt11-${invoiceCounter}`,
          }
        },
      }),
      notifier,
      log,
      feePercent: 0.05,
      translate,
      ...overrides,
    }
  }

  function buildService(overrides: Partial<SettleServiceDeps> = {}) {
    return createSettleService(baseDeps(overrides))
  }

  async function createPayment(overrides: Record<string, unknown> = {}) {
    return payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-test',
      paymentHash: 'subscriber-hash',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
      ...overrides,
    })
  }

  test('1. happy path: subscription created, payment deleted, both messages, settled', async () => {
    const settle = buildService()
    const payment = await createPayment()

    expect(await settle.complete(payment)).toBe('settled')

    const sub = await subscriptions.findByUserAndChat(2, -100)
    expect(sub?.endsAt).toBeInstanceOf(Date)
    expect(await payments.findById(payment.id)).toBeUndefined()
    expect(notifier.calls.filter(c => c.kind === 'send')).toHaveLength(2)
    expect(paidBolt11s.length).toBeGreaterThanOrEqual(1)
  })

  test('2. settledAt already set: subscription not extended again, settle completes', async () => {
    const settle = buildService()
    const first = await createPayment()
    await settle.complete(first)

    const endsAt = (await subscriptions.findByUserAndChat(2, -100))?.endsAt?.getTime()

    const retry = await createPayment({
      paymentRequest: 'lnbc-retry',
      paymentHash: 'subscriber-hash-2',
    })
    const alreadySettled = {...retry, settledAt: new Date()}
    notifier.calls.length = 0

    expect(await settle.complete(alreadySettled)).toBe('settled')
    expect((await subscriptions.findByUserAndChat(2, -100))?.endsAt?.getTime()).toBe(endsAt)
  })

  test('3. owner payout pending → kept, payment row lives, payoutHash preserved', async () => {
    // Pending is detected on retry when a stored hash is still in flight (not on first pay).
    ledger.set('in-flight-owner', {paid: false})
    const settle = buildService()
    const payment = await createPayment({payoutHash: 'in-flight-owner'})

    expect(await settle.complete(payment)).toBe('kept')

    const row = await payments.findById(payment.id)
    expect(row).toBeDefined()
    expect(row?.payoutHash).toBe('in-flight-owner')
    expect(paidBolt11s).toHaveLength(0)
  })

  test('4. stored payoutHash already paid → no second owner payout', async () => {
    ledger.set('existing-owner-hash', {paid: true})
    const settle = buildService()
    await settle.complete(await createPayment({payoutHash: 'existing-owner-hash'}))

    expect(paidBolt11s.filter(b => b.startsWith('bolt11-'))).toHaveLength(0)
    expect(paidBolt11s.some(b => b.startsWith('fee-'))).toBe(true)
  })

  test('5. lookup 404 on stored hash → re-issue payout (retryable)', async () => {
    const settle = buildService()
    expect(await settle.complete(await createPayment({payoutHash: 'ghost-hash'}))).toBe('settled')
    expect(paidBolt11s.some(b => b.startsWith('bolt11-'))).toBe(true)
  })

  test('6. fee percent 0 → no fee leg', async () => {
    const settle = buildService({feePercent: 0})
    await settle.complete(await createPayment())
    expect(paidBolt11s.filter(b => b.startsWith('fee-'))).toHaveLength(0)
    expect(paidBolt11s.filter(b => b.startsWith('bolt11-'))).toHaveLength(1)
  })

  test('7. kind renewal → subscription-renewal.renewed text, not invoice.paid', async () => {
    await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt: new Date('2026-04-01T12:00:00.000Z'),
    })
    const settle = buildService()
    await settle.complete(await createPayment({kind: 'renewal'}))

    const userMsg = notifier.calls.find(c => c.kind === 'send' && c.userId === 2)
    expect(userMsg?.kind).toBe('send')
    if (userMsg?.kind !== 'send') throw new Error('expected user message')

    const paidMsg = translate('subscription-invoice.paid', 'en', {
      title: 'Test Community',
      type: 'monthly',
    })
    expect(userMsg.text).not.toBe(paidMsg)
    expect(userMsg.text).toContain('Test Community')
  })

  test('8. settle attempts at MAX → exhausted error logged, row kept', async () => {
    ledger.set('still-pending', {paid: false})
    const payment = await createPayment({payoutHash: 'still-pending'})
    for (let i = 0; i < MAX_SETTLE_ATTEMPTS - 1; i++) {
      await payments.recordSettleAttempt(payment.id)
    }
    const row = await payments.findById(payment.id)
    if (!row) throw new Error('missing payment')

    const settle = buildService({
      log: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (obj: unknown, msg?: string) => {
          if (typeof obj === 'string') logErrors.push(obj)
          if (msg) logErrors.push(msg)
        },
      },
    })

    expect(
      await settle.complete({
        ...row,
        settleAttempts: MAX_SETTLE_ATTEMPTS - 1,
        payoutHash: 'still-pending',
      }),
    ).toBe('kept')
    expect(logErrors.some(m => m.includes('exhausted its settle attempts'))).toBe(true)
    expect(await payments.findById(payment.id)).toBeDefined()
  })

  test('9. duplicate refund credits the full price and marks the attempt only after payment', async () => {
    const settle = buildService()
    const payment = await createPayment()

    expect(await settle.refundDuplicate(payment)).toEqual({status: 'credited'})

    const refunded = await payments.findById(payment.id)
    expect(invoiceSats).toEqual([payment.price])
    expect(paidBolt11s).toHaveLength(1)
    expect(refunded).toMatchObject({
      attemptStatus: 'processed',
      refundPayoutHash: expect.any(String),
      processedAt: expect.any(Date),
      refundedAt: expect.any(Date),
    })
    const completed = await payments.findById(payment.id)
    if (!completed) throw new Error('Missing completed refund attempt')
    expect(await settle.refundDuplicate(completed)).toEqual({status: 'credited'})
    expect(paidBolt11s).toHaveLength(1)
    expect(invoiceSats).toHaveLength(1)
  })

  test('10. crash after refund payment resumes from the stored hash without paying twice', async () => {
    const deps = baseDeps()
    const payInvoice = deps.masterWallet.payInvoice
    let crashOnce = true
    deps.masterWallet.payInvoice = async bolt11 => {
      await payInvoice(bolt11)
      if (crashOnce) {
        crashOnce = false
        throw new Error('crash after refund payment')
      }
    }
    const settle = createSettleService(deps)
    const payment = await createPayment()

    await expect(settle.refundDuplicate(payment)).rejects.toThrow('crash after refund payment')
    const afterCrash = await payments.findById(payment.id)
    if (!afterCrash) throw new Error('Missing refund attempt after crash')
    expect(afterCrash.attemptStatus).toBe('pending')
    expect(afterCrash.refundPayoutHash).toBe('hash-1')
    expect(afterCrash.refundedAt).toBeNull()
    expect(paidBolt11s).toEqual(['bolt11-1'])
    expect(ledger.get(afterCrash.refundPayoutHash ?? '')).toEqual({paid: true})

    expect(await settle.refundDuplicate(afterCrash)).toEqual({status: 'credited'})
    expect(paidBolt11s).toEqual(['bolt11-1'])
    expect(invoiceSats).toHaveLength(1)
    expect(await payments.findById(payment.id)).toMatchObject({
      attemptStatus: 'processed',
      refundedAt: expect.any(Date),
    })
  })

  test('11. an in-flight stored refund stays pending and is never re-sent', async () => {
    ledger.set('refund-in-flight', {paid: false})
    const settle = buildService()
    const payment = await createPayment({refundPayoutHash: 'refund-in-flight'})

    expect(await settle.refundDuplicate(payment)).toEqual({status: 'pending'})

    expect(paidBolt11s).toEqual([])
    expect(invoiceSats).toEqual([])
    expect(await payments.findById(payment.id)).toMatchObject({
      attemptStatus: 'pending',
      refundPayoutHash: 'refund-in-flight',
      refundedAt: null,
    })
  })

  test('12. a processed winner cannot be mislabeled as an already credited refund', async () => {
    const settle = buildService()
    const payment = await createPayment({
      attemptStatus: 'processed',
      processedAt: new Date('2026-06-01T12:00:00.000Z'),
    })

    await expect(settle.refundDuplicate(payment)).rejects.toThrow('processed without a refund')
    expect(paidBolt11s).toEqual([])
    expect(invoiceSats).toEqual([])
  })

  test('13. complete routes one shared-intent winner to payout and the duplicate to refund', async () => {
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'join'})
    const winner = await createPayment({
      intentId: intent.id,
      paymentRequest: 'lnbc-winner',
      paymentHash: 'subscriber-winner',
    })
    const duplicate = await createPayment({
      intentId: intent.id,
      paymentRequest: 'lnbc-duplicate',
      paymentHash: 'subscriber-duplicate',
      isCurrent: false,
    })
    const settle = buildService()

    expect(await settle.complete(winner)).toBe('settled')
    notifier.calls.length = 0
    expect(await settle.complete(duplicate)).toBe('settled')

    expect(invoiceSats).toEqual([950, 1000])
    expect(await payments.findById(winner.id)).toMatchObject({
      attemptStatus: 'processed',
      refundedAt: null,
    })
    expect(await payments.findById(duplicate.id)).toMatchObject({
      attemptStatus: 'processed',
      refundedAt: expect.any(Date),
    })
    expect(notifier.calls).toEqual([
      expect.objectContaining({kind: 'send', userId: 2, text: expect.stringContaining('credited')}),
    ])
  })

  test('14. complete does not notify while a duplicate refund is pending', async () => {
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'join'})
    const winner = await createPayment({
      intentId: intent.id,
      paymentRequest: 'lnbc-pending-winner',
      paymentHash: 'subscriber-pending-winner',
    })
    const duplicate = await createPayment({
      intentId: intent.id,
      paymentRequest: 'lnbc-pending-duplicate',
      paymentHash: 'subscriber-pending-duplicate',
      refundPayoutHash: 'refund-in-flight',
      isCurrent: false,
    })
    ledger.set('refund-in-flight', {paid: false})
    const settle = buildService()
    await settle.complete(winner)
    notifier.calls.length = 0

    expect(await settle.complete(duplicate)).toBe('kept')
    expect(notifier.calls).toEqual([])
    expect(await payments.findById(duplicate.id)).toMatchObject({
      attemptStatus: 'pending',
      refundedAt: null,
    })
  })
})
