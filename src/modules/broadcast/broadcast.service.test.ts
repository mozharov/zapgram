import {expect, test} from 'bun:test'
import {
  BROADCAST_MIN_INTERVAL_MS,
  createBroadcastService,
} from '@modules/broadcast/broadcast.service.js'
import {createBroadcastRepository} from '@modules/broadcast/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

function makeLog() {
  const entries: unknown[] = []
  return {
    entries,
    info: (...args: unknown[]) => {
      entries.push(['info', ...args])
    },
    warn: (...args: unknown[]) => {
      entries.push(['warn', ...args])
    },
    error: (...args: unknown[]) => {
      entries.push(['error', ...args])
    },
  }
}

async function setup() {
  const db = createTestDb()
  const users = createUserRepository(db)
  const broadcasts = createBroadcastRepository(db)
  await users.getOrCreate({id: 1, username: 'admin', languageCode: 'en'})
  await users.getOrCreate({id: 2, username: 'en_user', languageCode: 'en'})
  await users.getOrCreate({id: 3, username: 'ru_user', languageCode: 'ru'})
  return {users, broadcasts}
}

test('startBroadcast excludes admin and wrong locale', async () => {
  const {users, broadcasts} = await setup()
  const copies: number[] = []
  const reports: string[] = []
  const service = createBroadcastService({
    broadcasts,
    users,
    copyMessage: async toUserId => {
      copies.push(toUserId)
      return 'sent'
    },
    notifyAdmin: async (_id, text) => {
      reports.push(text)
      return true
    },
    formatStarted: (locale, n) => `start ${locale} ${n}`,
    formatReport: b => `done ${b.sentCount}/${b.totalCount}`,
    log: makeLog() as never,
    minIntervalMs: 0,
  })

  const {broadcast, totalCount} = await service.startBroadcast({
    adminUserId: 1,
    locale: 'en',
    sourceChatId: 1,
    sourceMessageId: 42,
  })
  expect(totalCount).toBe(1)
  expect(broadcast.totalCount).toBe(1)

  await service.processQueue()
  expect(copies).toEqual([2])
  expect(reports).toEqual(['done 1/1'])
  expect(await broadcasts.countPending(broadcast.id)).toBe(0)
  expect((await broadcasts.findById(broadcast.id))?.status).toBe('completed')
})

test('blocked copy marks user botBlocked and skipped', async () => {
  const {users, broadcasts} = await setup()
  const service = createBroadcastService({
    broadcasts,
    users,
    copyMessage: async () => 'blocked',
    notifyAdmin: async () => true,
    formatStarted: () => '',
    formatReport: b => `s${b.skippedCount}`,
    log: makeLog() as never,
    minIntervalMs: 0,
  })

  const {broadcast} = await service.startBroadcast({
    adminUserId: 1,
    locale: 'en',
    sourceChatId: 1,
    sourceMessageId: 1,
  })
  await service.processQueue()

  expect((await users.findById(2))?.botBlocked).toBe(true)
  const fresh = await broadcasts.findById(broadcast.id)
  expect(fresh?.skippedCount).toBe(1)
  expect(fresh?.sentCount).toBe(0)
})

test('BROADCAST_MIN_INTERVAL_MS is under 30 msg/s headroom', () => {
  expect(BROADCAST_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(40)
  expect(1000 / BROADCAST_MIN_INTERVAL_MS).toBeLessThanOrEqual(25)
})
