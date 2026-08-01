import {describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createSubscriptionRepository} from './repository.js'

async function seed(db: ReturnType<typeof createTestDb>) {
  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  const subscriptions = createSubscriptionRepository(db)
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
  return {users, chats, subscriptions}
}

describe('subscription repository', () => {
  test('getExpiringWithin respects the window and notificationSent flag', async () => {
    const db = createTestDb()
    const {subscriptions} = await seed(db)
    const now = new Date('2026-06-01T12:00:00.000Z')
    const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1000)
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000)
    const past = new Date(now.getTime() - 60 * 60 * 1000)

    await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt: in12h,
      notificationSent: false,
    })
    await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt: in12h,
      notificationSent: true, // already notified
    })
    await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt: in48h, // outside 24h window if max is now+24h
      notificationSent: false,
    })
    await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt: past, // already expired
      notificationSent: false,
    })

    const maxExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const found = await subscriptions.getExpiringWithin(maxExpiry, now, 50, 0)
    expect(found).toHaveLength(1)
    expect(found[0]?.endsAt?.getTime()).toBe(in12h.getTime())
    expect(found[0]?.notificationSent).toBe(false)

    expect(await subscriptions.countExpiringWithin(maxExpiry, now)).toBe(1)
  })

  test('delete does not remove a subscription whose endsAt moved forward', async () => {
    const db = createTestDb()
    const {subscriptions} = await seed(db)
    const endsAt = new Date('2026-06-01T12:00:00.000Z')
    const later = new Date('2026-07-01T12:00:00.000Z')

    const sub = await subscriptions.create({
      userId: 2,
      chatId: -100,
      price: 1000,
      endsAt,
    })

    // Concurrent renewal already extended endsAt past the "now" used for delete.
    await subscriptions.update(sub.id, {endsAt: later})

    await subscriptions.delete(sub.id, endsAt)

    const stillThere = await subscriptions.findByUserAndChat(2, -100)
    // findByUserAndChat returns first match — we may have only one row
    const byId = await subscriptions.findByIdWithChat(sub.id)
    expect(byId).not.toBeNull()
    expect(byId?.endsAt?.getTime()).toBe(later.getTime())
    expect(stillThere?.id).toBe(sub.id)
  })
})
