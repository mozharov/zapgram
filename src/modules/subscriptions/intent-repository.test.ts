import {describe, expect, test} from 'bun:test'
import {subscriptionIntentsTable} from '@infra/db/schema.js'
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
})
