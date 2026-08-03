import {describe, expect, test} from 'bun:test'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createSubscriptionIntentRepository} from './intent-repository.js'
import {createSubscriptionPaymentRepository, MAX_SETTLE_ATTEMPTS} from './payment-repository.js'

async function seedOwnerAndChat(db: ReturnType<typeof createTestDb>) {
  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  await users.createOrUpdate({id: 1, languageCode: 'en', firstName: 'Owner'})
  await users.createOrUpdate({id: 2, languageCode: 'en', firstName: 'Sub'})
  await chats.createOrUpdate({
    id: -100,
    title: 'Paid Chat',
    type: 'supergroup',
    ownerId: 1,
    status: 'active',
    price: 1000,
    paymentType: 'monthly',
  })
  return {users, chats}
}

describe('subscription payment repository', () => {
  test('countSettleable / getSettleable respect MAX_SETTLE_ATTEMPTS', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const payments = createSubscriptionPaymentRepository(db)

    await payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc1',
      paymentHash: 'h1',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })
    const exhausted = await payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc2',
      paymentHash: 'h2',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })
    // Burn settle attempts past the limit.
    for (let i = 0; i < MAX_SETTLE_ATTEMPTS; i++) {
      await payments.recordSettleAttempt(exhausted.id)
    }

    expect(await payments.countSettleable()).toBe(1)
    expect(await payments.countExhausted()).toBe(1)
    const settleable = await payments.getSettleable()
    expect(settleable).toHaveLength(1)
    expect(settleable[0]?.paymentHash).toBe('h1')
  })

  test('getPendingForSubscription finds an unfinished payment', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const payments = createSubscriptionPaymentRepository(db)

    expect(await payments.getPendingForSubscription(2, -100)).toBeUndefined()

    const created = await payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-pending',
      paymentHash: 'hash-pending',
      price: 500,
      subscriptionType: 'monthly',
      kind: 'renewal',
    })

    const found = await payments.getPendingForSubscription(2, -100)
    expect(found?.id).toBe(created.id)
    expect(found?.paymentHash).toBe('hash-pending')
  })

  test('creates and deletes a one-to-one legacy intent for old producers', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const payments = createSubscriptionPaymentRepository(db)

    const payment = await payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-legacy',
      paymentHash: 'hash-legacy',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })

    expect(payment.intentId).toBe(payment.id)
    expect(await db.select().from(subscriptionIntentsTable)).toEqual([
      expect.objectContaining({id: payment.id, status: 'legacy'}),
    ])

    await payments.delete(payment.id)

    expect(await db.select().from(subscriptionPaymentsTable)).toEqual([])
    expect(await db.select().from(subscriptionIntentsTable)).toEqual([])
  })

  test('allows only one current attempt per shared intent', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'join'})

    await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-current',
      paymentHash: 'hash-current',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
      expiresAt: new Date('2026-06-01T12:00:00.000Z'),
    })

    await expect(
      payments.create({
        intentId: intent.id,
        userId: 2,
        chatId: -100,
        paymentRequest: 'lnbc-second-current',
        paymentHash: 'hash-second-current',
        price: 1000,
        subscriptionType: 'monthly',
        kind: 'join',
      }),
    ).rejects.toThrow()

    await expect(
      payments.create({
        intentId: intent.id,
        userId: 2,
        chatId: -100,
        paymentRequest: 'lnbc-history',
        paymentHash: 'hash-history',
        price: 1000,
        subscriptionType: 'monthly',
        kind: 'join',
        isCurrent: false,
        attemptStatus: 'expired',
        processedAt: new Date('2026-06-01T13:00:00.000Z'),
      }),
    ).resolves.toMatchObject({intentId: intent.id, isCurrent: false, attemptStatus: 'expired'})
  })

  test('rejects an attempt whose owner, chat or kind does not match its intent', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'renewal'})

    await expect(
      payments.create({
        intentId: intent.id,
        userId: 1,
        chatId: -100,
        paymentRequest: 'lnbc-mismatch',
        paymentHash: 'hash-mismatch',
        price: 1000,
        subscriptionType: 'monthly',
        kind: 'renewal',
      }),
    ).rejects.toThrow('does not match its intent')

    expect(await db.select().from(subscriptionPaymentsTable)).toEqual([])
  })

  test('rejects duplicate BOLT11 invoices and payment hashes atomically', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const payments = createSubscriptionPaymentRepository(db)
    const base = {
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-unique',
      paymentHash: 'hash-unique',
      price: 1000,
      subscriptionType: 'monthly' as const,
      kind: 'join' as const,
    }

    await payments.create(base)
    await expect(payments.create({...base, paymentHash: 'hash-other'})).rejects.toThrow()
    await expect(payments.create({...base, paymentRequest: 'lnbc-other'})).rejects.toThrow()

    expect(await db.select().from(subscriptionPaymentsTable)).toHaveLength(1)
    expect(await db.select().from(subscriptionIntentsTable)).toHaveLength(1)
  })

  test('atomically selects one winner and sends every other paid attempt to refund', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'join'})
    const first = await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-winner-a',
      paymentHash: 'hash-winner-a',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })
    const second = await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-winner-b',
      paymentHash: 'hash-winner-b',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
      isCurrent: false,
    })

    const outcomes = await Promise.all([
      payments.claimPaidAttempt(first.id),
      payments.claimPaidAttempt(second.id),
    ])

    expect(outcomes.sort()).toEqual(['already_won_refund', 'winner'])
    const claimed = await intents.findById(intent.id)
    expect(claimed).toMatchObject({status: 'won'})
    if (!claimed?.winnerAttemptId) throw new Error('Expected a claimed winner')
    expect([first.id, second.id]).toContain(claimed.winnerAttemptId)
    const winner = claimed.winnerAttemptId === first.id ? first : second
    const duplicate = winner.id === first.id ? second : first
    expect(await payments.claimPaidAttempt(winner.id)).toBe('winner')
    expect(await payments.claimPaidAttempt(duplicate.id)).toBe('already_won_refund')
  })

  test('winner completion and refund completion are idempotent state transitions', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const intent = await intents.create({userId: 2, chatId: -100, kind: 'join'})
    const winner = await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-complete-winner',
      paymentHash: 'hash-complete-winner',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })
    const duplicate = await payments.create({
      intentId: intent.id,
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-complete-refund',
      paymentHash: 'hash-complete-refund',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
      isCurrent: false,
    })
    const completedAt = new Date('2026-06-01T12:00:00.000Z')

    expect(await payments.claimPaidAttempt(winner.id, completedAt)).toBe('winner')
    await payments.markWinnerCompleted(winner.id, completedAt)
    await payments.markWinnerCompleted(winner.id, completedAt)
    await payments.recordRefundInvoice(duplicate.id, 'refund-hash')
    await payments.markRefundCredited(duplicate.id, completedAt)
    await payments.markRefundCredited(duplicate.id, completedAt)

    expect(await payments.claimPaidAttempt(winner.id)).toBe('already_processed')
    expect(await payments.claimPaidAttempt(duplicate.id)).toBe('already_processed')
    expect(await intents.findById(intent.id)).toMatchObject({
      status: 'completed',
      winnerAttemptId: winner.id,
    })
    expect(await payments.findById(winner.id)).toMatchObject({
      attemptStatus: 'processed',
      processedAt: completedAt,
    })
    expect(await payments.findById(duplicate.id)).toMatchObject({
      attemptStatus: 'processed',
      refundPayoutHash: 'refund-hash',
      refundedAt: completedAt,
    })
    expect(await payments.countSettleable()).toBe(0)
  })
})
