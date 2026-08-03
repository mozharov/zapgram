import {describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createGrantSubscriptionAccess} from './access.js'
import {createSubscriptionPaymentRepository} from './payment-repository.js'
import {createSubscriptionRepository} from './repository.js'

describe('grantSubscriptionAccess on real DB', () => {
  test('second call with the same payment does not extend the subscription again', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const chats = createChatRepository(db)
    const payments = createSubscriptionPaymentRepository(db)
    const subscriptions = createSubscriptionRepository(db)
    const grant = createGrantSubscriptionAccess(db, {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    })

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

    const payment = await payments.create({
      userId: 2,
      chatId: -100,
      paymentRequest: 'lnbc-grant',
      paymentHash: 'hash-grant',
      price: 1000,
      subscriptionType: 'monthly',
      kind: 'join',
    })

    const now = new Date('2026-03-01T12:00:00.000Z')
    expect(grant(payment, now)).toBe('granted')

    const afterFirst = await subscriptions.findByUserAndChat(2, -100, now)
    expect(afterFirst).toBeDefined()
    if (!afterFirst) throw new Error('expected subscription after grant')
    const firstEndsAt = afterFirst.endsAt
    expect(firstEndsAt).toBeInstanceOf(Date)
    if (!firstEndsAt) throw new Error('expected endsAt after monthly grant')

    const settledPayment = await payments.findById(payment.id)
    expect(settledPayment?.settledAt).toBeInstanceOf(Date)
    if (!settledPayment) throw new Error('expected settled payment row')

    expect(grant(settledPayment, now)).toBe('already_settled')

    const afterSecond = await subscriptions.findByUserAndChat(2, -100, now)
    expect(afterSecond?.endsAt?.getTime()).toBe(firstEndsAt.getTime())
  })
})
