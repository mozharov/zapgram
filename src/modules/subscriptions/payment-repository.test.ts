import {describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
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
})
