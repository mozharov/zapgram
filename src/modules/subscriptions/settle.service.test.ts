import {beforeEach, describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createFakeNotifier} from '@test/helpers/fakes/notifier.js'
import {HTTPError} from 'got'
import {translate} from '../../bot/lib/i18n.js'
import {createGrantSubscriptionAccess} from './access.js'
import {createSubscriptionPaymentRepository, MAX_SETTLE_ATTEMPTS} from './payment-repository.js'
import {createSubscriptionRepository} from './repository.js'
import {createSettleService, type SettleServiceDeps} from './settle.service.js'

function silentLog() {
  return {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}}
}

describe('settle service (characterization)', () => {
  let db: ReturnType<typeof createTestDb>
  let payments: ReturnType<typeof createSubscriptionPaymentRepository>
  let subscriptions: ReturnType<typeof createSubscriptionRepository>
  let users: ReturnType<typeof createUserRepository>
  let chats: ReturnType<typeof createChatRepository>
  let notifier: ReturnType<typeof createFakeNotifier>
  let ledger: Map<string, {paid: boolean; status?: string}>
  let paidBolt11s: string[]
  let invoiceCounter: number
  let logErrors: string[]

  beforeEach(async () => {
    db = createTestDb()
    payments = createSubscriptionPaymentRepository(db)
    subscriptions = createSubscriptionRepository(db)
    users = createUserRepository(db)
    chats = createChatRepository(db)
    notifier = createFakeNotifier()
    ledger = new Map()
    paidBolt11s = []
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
      grantAccess: createGrantSubscriptionAccess(db, log),
      approveChatJoinRequest: async () => {},
      getChatOrThrow: id => chats.getOrThrow(id),
      getUserOrThrow: id => users.getOrThrow(id),
      deletePayment: id => payments.delete(id),
      findSubscriptionByUserAndChat: (userId, chatId) =>
        subscriptions.findByUserAndChat(userId, chatId),
      recordPayoutInvoice: (id, hash) => payments.recordPayoutInvoice(id, hash),
      recordFeePayoutInvoice: (id, hash) => payments.recordFeePayoutInvoice(id, hash),
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
        createInvoice: async () => {
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
})
