import {expect, test} from 'bun:test'
import {donationPlatformStatsTable, donationsTable} from '@infra/db/schema.js'
import {createDonationRepository} from '@modules/donations/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

test('insert donation and getUserStats aggregate successful rows', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const donations = createDonationRepository(db)
  await users.createOrUpdate({id: 1, username: 'a'})

  await donations.insertDonation({userId: 1, amountSats: 100, kind: 'one_shot'})
  await donations.insertDonation({userId: 1, amountSats: 50, kind: 'percent'})

  const stats = await donations.getUserStats(1)
  expect(stats.totalSats).toBe(150)
  expect(stats.count).toBe(2)
  expect(stats.lastAt).toBeInstanceOf(Date)
})

test('getUserStats is zero for users with no donations', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const donations = createDonationRepository(db)
  await users.createOrUpdate({id: 2, username: 'b'})
  const stats = await donations.getUserStats(2)
  expect(stats).toEqual({totalSats: 0, count: 0, lastAt: null})
})

test('platform stats singleton tracks all-time and last-month window', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const donations = createDonationRepository(db)
  await users.createOrUpdate({id: 1, username: 'a'})
  await users.createOrUpdate({id: 2, username: 'b'})

  expect(await donations.getPlatformStats()).toMatchObject({
    totalSats: 0,
    totalCount: 0,
    lastMonthSats: 0,
    lastMonthCount: 0,
  })

  await donations.insertDonation({userId: 1, amountSats: 1000, kind: 'one_shot'})
  await donations.insertDonation({userId: 2, amountSats: 500, kind: 'monthly'})

  const platform = await donations.getPlatformStats()
  expect(platform.totalSats).toBe(1500)
  expect(platform.totalCount).toBe(2)
  expect(platform.lastMonthSats).toBe(1500)
  expect(platform.lastMonthCount).toBe(2)
})

test('insert donation rolls the ledger back when the platform total cannot be updated', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const donations = createDonationRepository(db)
  await users.createOrUpdate({id: 1, username: 'a'})
  const sqlite = Reflect.get(db, '$client') as {exec(sql: string): void}
  sqlite.exec(`
    CREATE TRIGGER donations_stats_abort
    BEFORE INSERT ON donation_platform_stats
    WHEN NEW.total_sats = 777
    BEGIN
      SELECT RAISE(ABORT, 'stats aborted');
    END;
  `)

  await expect(
    donations.insertDonation({userId: 1, amountSats: 777, kind: 'one_shot'}),
  ).rejects.toThrow('stats aborted')
  expect(await db.select().from(donationsTable)).toEqual([])
  // Migration seeds the singleton at zero. A failed total update must leave it there.
  expect(await db.select().from(donationPlatformStatsTable)).toEqual([
    expect.objectContaining({id: 1, totalSats: 0, totalCount: 0}),
  ])
})
