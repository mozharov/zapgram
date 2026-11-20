import {expect, test} from 'bun:test'
import {donationPlatformStatsTable, donationsTable} from '@infra/db/schema.js'
import {createDonationRepository} from '@modules/donations/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {sql} from 'drizzle-orm'

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

test('pending payments preserve independent hashes and settle atomically only once', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const repo = createDonationRepository(db)
  await users.createOrUpdate({id: 1})
  const expiresAt = new Date(Date.now() + 60_000)
  for (const [paymentHash, kind, amountSats] of [
    ['tip-1', 'percent', 5],
    ['tip-2', 'percent', 10],
    ['feature', 'feature_request', 21],
    ['explicit', 'one_shot', 50],
  ] as const)
    await repo.savePending({userId: 1, paymentHash, kind, amountSats, expiresAt})
  expect(await repo.listPending(1, 'percent')).toHaveLength(2)
  await repo.insertDonation({userId: 1, paymentHash: 'tip-1', kind: 'percent', amountSats: 5})
  await Promise.all([repo.completePending('tip-1'), repo.completePending('tip-1')])
  expect(await repo.listPending()).toHaveLength(3)
  expect((await repo.getUserStats(1)).count).toBe(1)
  await repo.completePending('feature')
  expect(await repo.findByPaymentHash('feature')).toMatchObject({amountSats: 21, kind: 'one_shot'})
  await repo.completePending('tip-2')
  await repo.completePending('explicit')
  expect(await repo.listPending()).toEqual([])
  expect(await repo.getUserStats(1)).toMatchObject({count: 4, totalSats: 86})
  expect(await repo.getPlatformStats()).toMatchObject({totalCount: 4, totalSats: 86})
  await expect(
    repo.savePending({
      userId: 999,
      paymentHash: 'bad-user',
      kind: 'percent',
      amountSats: 1,
      expiresAt,
    }),
  ).rejects.toThrow()
})

test('failed ledger totals write rolls back pending completion for a later retry', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  const repo = createDonationRepository(db)
  await users.createOrUpdate({id: 1})
  await repo.savePending({
    userId: 1,
    paymentHash: 'retry-ledger',
    kind: 'one_shot',
    amountSats: 21,
    expiresAt: new Date(),
  })
  db.run(sql`CREATE TRIGGER reject_donation_totals BEFORE INSERT ON donation_platform_stats
    BEGIN SELECT RAISE(ABORT, 'totals unavailable'); END`)
  await expect(repo.completePending('retry-ledger')).rejects.toThrow('totals unavailable')
  expect(await repo.listPending()).toHaveLength(1)
  expect(await repo.findByPaymentHash('retry-ledger')).toBeUndefined()
  db.run(sql`DROP TRIGGER reject_donation_totals`)
  await repo.completePending('retry-ledger')
  expect(await repo.listPending()).toHaveLength(0)
  expect(await repo.getPlatformStats()).toMatchObject({totalCount: 1, totalSats: 21})
})

test('issuance CAS excludes other repositories, scopes feature attempts and preserves percent hashes', async () => {
  const db = createTestDb()
  await createUserRepository(db).createOrUpdate({id: 1})
  const first = createDonationRepository(db)
  const other = createDonationRepository(db)
  const [owner, loser] = await Promise.all([
    first.reserveIssuance(1, 'one_shot'),
    other.reserveIssuance(1, 'one_shot'),
  ])
  if (!owner) throw new Error('Expected issuance owner')
  expect(loser).toBeNull()
  expect(await other.reserveIssuance(1, 'feature_request', 'a')).not.toBeNull()
  expect(await other.reserveIssuance(1, 'feature_request', 'b')).not.toBeNull()
  expect(await other.reserveIssuance(1, 'feature_request', 'a')).toBeNull()
  const row = {
    userId: 1,
    kind: 'one_shot' as const,
    paymentHash: 'issued',
    amountSats: 50,
    expiresAt: new Date(Date.now() + 60_000),
  }
  expect(await first.saveIssued(owner, row)).toBe(true)
  expect(await other.saveIssued(owner, {...row, paymentHash: 'duplicate'})).toBe(false)
  for (const paymentHash of ['tip-a', 'tip-b'])
    await other.savePending({...row, kind: 'percent', paymentHash})
  expect(await first.listPending(1, 'percent')).toHaveLength(2)
  await first.releaseIssuance(owner)
  const next = await other.reserveIssuance(1, 'one_shot')
  expect(next?.rows.map(row => row.paymentHash)).toEqual(['issued'])
  if (!next) throw new Error('Expected next owner')
  await first.releaseIssuance(owner)
  expect(await first.reserveIssuance(1, 'one_shot')).toBeNull()
  await other.releaseIssuance(next)
})

test('an expired issuance owner cannot persist or delete the next owner slot', async () => {
  const db = createTestDb()
  await createUserRepository(db).createOrUpdate({id: 1})
  const repo = createDonationRepository(db)
  const now = new Date()
  const before = new Date(now.getTime() - 86_401_000)
  const expired = await repo.reserveIssuance(1, 'one_shot', undefined, before)
  if (!expired) throw new Error('Expected old lease')
  const row = {
    userId: 1,
    kind: 'one_shot' as const,
    paymentHash: 'stale',
    amountSats: 50,
    expiresAt: new Date(now.getTime() + 60_000),
  }
  expect(await repo.saveIssued(expired, row, now)).toBe(false)
  const current = await repo.reserveIssuance(1, 'one_shot', undefined, now)
  if (!current) throw new Error('Expected renewed lease')
  expect(current.token).not.toBe(expired.token)
  expect(await repo.saveIssued(expired, row, now)).toBe(false)
  await repo.releaseIssuance(expired)
  expect(await repo.reserveIssuance(1, 'one_shot', undefined, now)).toBeNull()
  expect(await repo.saveIssued(current, {...row, paymentHash: 'current'}, now)).toBe(true)
})

test('transactional issuance snapshot retains the hash even if cron completes it before lookup', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.createOrUpdate({id: 1})
  await users.createOrUpdate({id: 2})
  const repo = createDonationRepository(db)
  await repo.savePending({
    userId: 1,
    kind: 'feature_request',
    attemptId: 'a',
    paymentHash: 'fund-a',
    amountSats: 21,
    expiresAt: new Date(),
  })
  const slot = await repo.reserveIssuance(1, 'feature_request', 'a')
  if (!slot) throw new Error('Expected lease')
  await Promise.all([repo.completePending('fund-a'), repo.completePending('fund-a')])
  expect(slot.rows.map(row => row.paymentHash)).toEqual(['fund-a'])
  expect(await repo.listPending()).toEqual([])
  expect(await repo.findByAttempt(1, 'a')).toMatchObject({
    paymentHash: 'fund-a',
    amountSats: 21,
    kind: 'one_shot',
  })
  expect(await repo.findByAttempt(1, 'b')).toBeUndefined()
  expect(await repo.findByAttempt(2, 'a')).toBeUndefined()
  expect(await repo.getUserStats(1)).toMatchObject({count: 1, totalSats: 21})
})
