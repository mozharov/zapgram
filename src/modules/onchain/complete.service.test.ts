import {describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createGrantSubscriptionAccess} from '@modules/subscriptions/access.js'
import {createSubscriptionIntentRepository} from '@modules/subscriptions/intent-repository.js'
import {createSubscriptionPaymentRepository} from '@modules/subscriptions/payment-repository.js'
import {createSubscriptionRepository} from '@modules/subscriptions/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createCompleteOnchainJoinService} from './complete.service.js'
import {createOnchainPaymentRepository} from './repository.js'

async function seedChat(db: ReturnType<typeof createTestDb>) {
  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  await users.createOrUpdate({id: 1, languageCode: 'en', firstName: 'Owner', username: 'owner'})
  await users.createOrUpdate({id: 2, languageCode: 'en', firstName: 'Sub'})
  await chats.createOrUpdate({
    id: -100,
    title: 'Paid',
    type: 'supergroup',
    ownerId: 1,
    status: 'active',
    price: 1000,
    paymentType: 'one_time',
    onchainEnabled: true,
    watchonlyWalletId: 'wo-1',
  })
  return {users, chats}
}

function buildService(
  db: ReturnType<typeof createTestDb>,
  onchainPayments: ReturnType<typeof createOnchainPaymentRepository>,
  notifies: Array<{userId: number; text: string}>,
) {
  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  const payments = createSubscriptionPaymentRepository(db)
  const intents = createSubscriptionIntentRepository(db)
  const grantAccess = createGrantSubscriptionAccess(db, {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  })

  return createCompleteOnchainJoinService({
    onchainPayments,
    getOrCreateJoinIntent: (userId, chatId) =>
      intents.getOrCreateActive({userId, chatId, kind: 'join'}),
    createSubscriptionPayment: data => payments.create(data),
    findSubscriptionPayment: id => payments.findById(id),
    claimPaidAttempt: (id, claimedAt) => payments.claimPaidAttempt(id, claimedAt),
    markWinnerCompleted: (id, processedAt) => payments.markWinnerCompleted(id, processedAt),
    grantAccess,
    approveChatJoinRequest: async () => undefined,
    getChatOrThrow: id => chats.getOrThrow(id),
    getUserOrThrow: id => users.getOrThrow(id),
    notifier: {
      send: async (userId, text) => {
        notifies.push({userId, text})
        return true
      },
      sendPhoto: async () => true,
    },
    log: {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}},
    translate: (key, _lang, vars) => `${key}:${JSON.stringify(vars ?? {})}`,
    now: () => new Date('2026-08-08T12:00:00.000Z'),
  })
}

describe('completeOnchainJoin', () => {
  test('grants access without LN payout and is idempotent', async () => {
    const db = createTestDb()
    await seedChat(db)
    const onchainPayments = createOnchainPaymentRepository(db)
    const subscriptions = createSubscriptionRepository(db)

    const expiresAt = new Date('2026-08-09T12:00:00.000Z')
    const watchUntil = new Date('2026-08-10T12:00:00.000Z')
    const row = await onchainPayments.create({
      chatId: -100,
      userId: 2,
      satspayChargeId: 'ch-complete',
      address: 'bc1qcomplete',
      amountSats: 1000,
      expiresAt,
      watchUntil,
    })

    const notifies: Array<{userId: number; text: string}> = []
    const service = buildService(db, onchainPayments, notifies)

    const first = await service.completeFromCharge({
      chargeId: 'ch-complete',
      paid: true,
      extra: JSON.stringify({txids: ['txid-abc']}),
    })
    expect(first).toBe('settled')

    const sub = await subscriptions.findByUserAndChat(2, -100)
    expect(sub).toBeDefined()
    expect((await onchainPayments.findById(row.id))?.status).toBe('paid')
    expect((await onchainPayments.findById(row.id))?.txid).toBe('txid-abc')
    expect(notifies.some(n => n.userId === 2)).toBe(true)
    expect(notifies.some(n => n.userId === 1)).toBe(true)

    const second = await service.completeFromCharge({chargeId: 'ch-complete', paid: true})
    expect(second).toBe('already_settled')
  })

  test('settles when an open LN join intent already exists for the same user/chat', async () => {
    const db = createTestDb()
    await seedChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const onchainPayments = createOnchainPaymentRepository(db)
    const subscriptions = createSubscriptionRepository(db)

    // Mimic join-request: open intent + pending LN attempt (is_current).
    const {intent} = await intents.getOrCreateActive({userId: 2, chatId: -100, kind: 'join'})
    await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc1joinpending',
      paymentHash: 'hash-ln-join',
      price: 1000,
      subscriptionType: 'one_time',
      kind: 'join',
      isCurrent: true,
    })

    const row = await onchainPayments.create({
      chatId: -100,
      userId: 2,
      satspayChargeId: 'ch-after-ln-intent',
      address: 'tb1qtest',
      amountSats: 1000,
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      watchUntil: new Date('2026-08-10T12:00:00.000Z'),
    })

    const notifies: Array<{userId: number; text: string}> = []
    const service = buildService(db, onchainPayments, notifies)

    const result = await service.completeFromCharge({
      chargeId: 'ch-after-ln-intent',
      paid: true,
      extra: JSON.stringify({txids: ['txid-onchain']}),
    })

    expect(result).toBe('settled')
    expect((await onchainPayments.findById(row.id))?.status).toBe('paid')
    expect(await subscriptions.findByUserAndChat(2, -100)).toBeDefined()
    expect(notifies.some(n => n.userId === 2)).toBe(true)
  })
})
