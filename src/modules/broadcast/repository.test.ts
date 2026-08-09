import {expect, test} from 'bun:test'
import {createBroadcastRepository} from '@modules/broadcast/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

async function setup() {
  const db = createTestDb()
  const users = createUserRepository(db)
  const broadcasts = createBroadcastRepository(db)
  await users.getOrCreate({id: 1, username: 'admin', languageCode: 'en'})
  await users.getOrCreate({id: 2, username: 'u2', languageCode: 'en'})
  await users.getOrCreate({id: 3, username: 'u3', languageCode: 'en'})
  return {broadcasts, users}
}

test('createSending snapshots recipients and lists pending', async () => {
  const {broadcasts} = await setup()
  const b = await broadcasts.createSending({
    adminUserId: 1,
    locale: 'en',
    sourceChatId: 1,
    sourceMessageId: 99,
    recipientUserIds: [2, 3],
  })
  expect(b.status).toBe('sending')
  expect(b.totalCount).toBe(2)
  expect(await broadcasts.countPending(b.id)).toBe(2)
  const pending = await broadcasts.listPendingRecipients(b.id, 10)
  expect(pending.map(p => p.userId).sort()).toEqual([2, 3])
})

test('markRecipient is idempotent and bumps aggregates once', async () => {
  const {broadcasts} = await setup()
  const b = await broadcasts.createSending({
    adminUserId: 1,
    locale: 'en',
    sourceChatId: 1,
    sourceMessageId: 1,
    recipientUserIds: [2],
  })

  expect(await broadcasts.markRecipient(b.id, 2, 'sent', null)).toBe(true)
  expect(await broadcasts.markRecipient(b.id, 2, 'sent', null)).toBe(false)

  const fresh = await broadcasts.findById(b.id)
  expect(fresh?.sentCount).toBe(1)
  expect(await broadcasts.countPending(b.id)).toBe(0)
})

test('deleteRecipients and deleteCompletedOlderThan purge state', async () => {
  const {broadcasts} = await setup()
  const past = new Date('2020-01-01T00:00:00Z')
  const b = await broadcasts.createSending({
    adminUserId: 1,
    locale: 'en',
    sourceChatId: 1,
    sourceMessageId: 1,
    recipientUserIds: [2],
    now: past,
  })
  await broadcasts.markRecipient(b.id, 2, 'sent', null, past)
  await broadcasts.markCompleted(b.id, past)
  await broadcasts.deleteRecipients(b.id)
  expect(await broadcasts.countPending(b.id)).toBe(0)

  const purged = await broadcasts.deleteCompletedOlderThan(new Date('2021-01-01T00:00:00Z'))
  expect(purged).toBe(1)
  expect(await broadcasts.findById(b.id)).toBeUndefined()
})
