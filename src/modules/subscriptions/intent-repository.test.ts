import {describe, expect, test} from 'bun:test'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createSubscriptionIntentRepository} from './intent-repository.js'

async function seedOwnerAndChat(db: ReturnType<typeof createTestDb>) {
  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  await users.createOrUpdate({id: 1, languageCode: 'en', firstName: 'Owner'})
  await users.createOrUpdate({id: 2, languageCode: 'en', firstName: 'Subscriber'})
  await chats.createOrUpdate({
    id: -100,
    title: 'Paid Chat',
    type: 'supergroup',
    ownerId: 1,
    status: 'active',
    price: 1000,
    paymentType: 'monthly',
  })
}

describe('subscription intent repository', () => {
  const identity = {userId: 2, chatId: -100, kind: 'join' as const}

  test('allows only one active intent for a user, chat and kind', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)

    const competingWrites = await Promise.allSettled([
      intents.create({userId: 2, chatId: -100, kind: 'join', status: 'open'}),
      intents.create({userId: 2, chatId: -100, kind: 'join', status: 'open'}),
    ])

    expect(competingWrites.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(
      intents.create({userId: 2, chatId: -100, kind: 'renewal', status: 'open'}),
    ).resolves.toMatchObject({kind: 'renewal', status: 'open'})
  })

  test('completed intents do not block the next active intent', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)

    await intents.create({
      userId: 2,
      chatId: -100,
      kind: 'join',
      status: 'completed',
      winnerAttemptId: 'winner-1',
    })

    await expect(
      intents.create({userId: 2, chatId: -100, kind: 'join', status: 'open'}),
    ).resolves.toMatchObject({kind: 'join', status: 'open'})
  })

  test('enforces winner state invariants', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)

    expect(() =>
      db
        .insert(subscriptionIntentsTable)
        .values({
          id: 'bad-open',
          userId: 2,
          chatId: -100,
          kind: 'join',
          status: 'open',
          winnerAttemptId: 'unexpected-winner',
        })
        .run(),
    ).toThrow()
    expect(() =>
      db
        .insert(subscriptionIntentsTable)
        .values({
          id: 'bad-won',
          userId: 2,
          chatId: -100,
          kind: 'join',
          status: 'won',
        })
        .run(),
    ).toThrow()
  })

  test('getOrCreateActive converges concurrent writes on one intent', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)

    const [first, second] = await Promise.all([
      intents.getOrCreateActive(identity),
      intents.getOrCreateActive(identity),
    ])

    expect(first.intent.id).toBe(second.intent.id)
    expect(first.currentAttempt).toBeUndefined()
    expect(second.currentAttempt).toBeUndefined()
    expect(await db.select().from(subscriptionIntentsTable)).toHaveLength(1)
  })

  test('a live reservation lets only one concurrent request mint an invoice', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const now = new Date('2026-06-01T12:00:00.000Z')

    const results = await Promise.all([
      intents.reserveInvoiceAttempt(identity, now),
      intents.reserveInvoiceAttempt(identity, now),
    ])

    expect(results.map(result => result.action).sort()).toEqual(['busy', 'reserved'])
    expect(new Set(results.map(result => result.intent.id)).size).toBe(1)
  })

  test('finalization stores exact expiry and replacement keeps the old attempt settleable', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const now = new Date('2026-06-01T12:00:00.000Z')
    const firstReservation = await intents.reserveInvoiceAttempt(identity, now)
    if (firstReservation.action !== 'reserved') throw new Error('Expected reservation')

    const first = await intents.finalizeReservedAttempt(
      firstReservation.intent.id,
      firstReservation.reservationId,
      {
        paymentRequest: 'lnbc-first',
        paymentHash: 'hash-first',
        price: 1000,
        subscriptionType: 'monthly',
        expiresAt: new Date('2026-06-01T14:00:00.000Z'),
      },
      now,
    )

    const reuse = await intents.reserveInvoiceAttempt(
      identity,
      new Date('2026-06-01T13:00:00.000Z'),
    )
    expect(reuse).toMatchObject({action: 'reuse', remainingMinutes: 60})
    if (reuse.action !== 'reuse') throw new Error('Expected reuse')
    expect(reuse.attempt.id).toBe(first.id)

    const replacement = await intents.reserveInvoiceAttempt(
      identity,
      new Date('2026-06-01T13:00:01.000Z'),
    )
    if (replacement.action !== 'reserved') throw new Error('Expected replacement reservation')
    const second = await intents.finalizeReservedAttempt(
      replacement.intent.id,
      replacement.reservationId,
      {
        paymentRequest: 'lnbc-second',
        paymentHash: 'hash-second',
        price: 1000,
        subscriptionType: 'monthly',
        expiresAt: new Date('2026-06-02T13:00:01.000Z'),
      },
      new Date('2026-06-01T13:00:02.000Z'),
    )

    expect(second.expiresAt).toEqual(new Date('2026-06-02T13:00:01.000Z'))
    expect(await db.select().from(subscriptionPaymentsTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: first.id, isCurrent: false, attemptStatus: 'pending'}),
        expect.objectContaining({id: second.id, isCurrent: true, attemptStatus: 'pending'}),
      ]),
    )
  })

  test('an expired lease can be replaced and its stale owner cannot finalize', async () => {
    const db = createTestDb()
    await seedOwnerAndChat(db)
    const intents = createSubscriptionIntentRepository(db)
    const now = new Date('2026-06-01T12:00:00.000Z')
    const stale = await intents.reserveInvoiceAttempt(identity, now, 60_000)
    if (stale.action !== 'reserved') throw new Error('Expected first reservation')

    const replacement = await intents.reserveInvoiceAttempt(
      identity,
      new Date('2026-06-01T12:01:00.000Z'),
      60_000,
    )
    if (replacement.action !== 'reserved') throw new Error('Expected replacement reservation')
    expect(replacement.reservationId).not.toBe(stale.reservationId)

    await expect(
      intents.finalizeReservedAttempt(
        stale.intent.id,
        stale.reservationId,
        {
          paymentRequest: 'lnbc-stale',
          paymentHash: 'hash-stale',
          price: 1000,
          subscriptionType: 'monthly',
          expiresAt: new Date('2026-06-02T12:00:00.000Z'),
        },
        new Date('2026-06-01T12:01:01.000Z'),
      ),
    ).rejects.toThrow('no longer active')
    expect(await db.select().from(subscriptionPaymentsTable)).toEqual([])
  })
})
