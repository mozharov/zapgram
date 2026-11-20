import {expect, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

function repo(defaultDonationPercent = 0) {
  return createUserRepository(createTestDb(), {defaultDonationPercent})
}

test('getOrCreate applies default donation percent only on insert', async () => {
  const users = createUserRepository(createTestDb(), {defaultDonationPercent: 5})
  const created = await users.getOrCreate({id: 10, username: 'new'})
  expect(created.donationPercent).toBe(5)
  expect(created.donationScope).toBe('tips')

  await users.update(10, {donationPercent: 0, donationScope: 'all'})
  const refreshed = await users.getOrCreate({
    id: 10,
    username: 'new2',
    firstName: 'X',
  })
  expect(refreshed.donationPercent).toBe(0)
  expect(refreshed.donationScope).toBe('all')
})

test('createOrUpdate without percent leaves schema default 0', async () => {
  const users = repo()
  const user = await users.createOrUpdate({id: 11, username: 'seeded'})
  expect(user.donationPercent).toBe(0)
  expect(user.monthlyDonationSats).toBe(0)
})

test('getOrCreate inserts a new user', async () => {
  const users = repo()
  const user = await users.getOrCreate({id: 1, username: 'Alice', firstName: 'A'})
  expect(user.id).toBe(1)
  expect(user.username).toBe('alice')
})

/**
 * Guard for the profile-refresh regression: findByUsername backs `/tip @name`. A stale row makes
 * tips fail, and once someone else takes the old handle it routes sats to the wrong person.
 */
test('getOrCreate refreshes a changed username', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'oldname', firstName: 'A'})

  await users.getOrCreate({id: 1, username: 'newname', firstName: 'A'})

  expect((await users.findById(1))?.username).toBe('newname')
  expect(await users.findByUsername('newname')).toBeTruthy()
  expect(await users.findByUsername('oldname')).toBeFalsy()
})

test('getOrCreate refreshes firstName and languageCode', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'a', firstName: 'Old', languageCode: 'en'})

  await users.getOrCreate({id: 1, username: 'a', firstName: 'New', languageCode: 'ru'})

  const user = await users.findById(1)
  expect(user?.firstName).toBe('New')
  expect(user?.languageCode).toBe('ru')
})

test('getOrCreate does not clobber stored fields the caller omitted', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'a', firstName: 'A', languageCode: 'ru'})

  // /tip passes no firstName
  await users.getOrCreate({id: 1, username: 'b', languageCode: 'ru'})

  const user = await users.findById(1)
  expect(user?.username).toBe('b')
  expect(user?.firstName).toBe('A')
  expect(user?.languageCode).toBe('ru')
})

test('setBotBlocked toggles the flag', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'a'})
  expect((await users.findById(1))?.botBlocked).toBe(false)

  await users.setBotBlocked(1, true)
  expect((await users.findById(1))?.botBlocked).toBe(true)

  await users.setBotBlocked(1, false)
  expect((await users.findById(1))?.botBlocked).toBe(false)
})

test('listBroadcastRecipientIds filters locale, blocked, and excludeUserId', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'admin', languageCode: 'en'})
  await users.getOrCreate({id: 2, username: 'en1', languageCode: 'en'})
  await users.getOrCreate({id: 3, username: 'ru1', languageCode: 'ru-RU'})
  await users.getOrCreate({id: 4, username: 'de1', languageCode: 'de'})
  await users.getOrCreate({id: 5, username: 'blocked', languageCode: 'en'})
  await users.setBotBlocked(5, true)

  const enIds = await users.listBroadcastRecipientIds({locale: 'en', excludeUserId: 1})
  expect(enIds.sort()).toEqual([2, 4])

  const ruIds = await users.listBroadcastRecipientIds({locale: 'ru', excludeUserId: 1})
  expect(ruIds).toEqual([3])
})

test('getOrCreate preserves languageCode when another profile field changes without it', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'old', firstName: 'A', languageCode: 'ru-RU'})

  await users.getOrCreate({id: 1, username: 'new', firstName: 'A', languageCode: undefined})

  const user = await users.findById(1)
  expect(user?.username).toBe('new')
  expect(user?.languageCode).toBe('ru-RU')
})

test('username lookups are case-insensitive on write and read', async () => {
  const users = repo()
  await users.getOrCreate({id: 1, username: 'MiXeD', firstName: 'A'})
  expect(await users.findByUsername('mixed')).toBeTruthy()
  expect(await users.findByUsername('MIXED')).toBeTruthy()
})

test('getOrCreate does not mutate the caller object', async () => {
  const users = repo()
  const data = {id: 1, username: 'MiXeD', firstName: 'A'}
  await users.getOrCreate(data)
  expect(data.username).toBe('MiXeD')
})

test('monthly work includes unresolved hashes even when disabled or not yet due', async () => {
  const users = repo()
  const now = new Date()
  const past = new Date(now.getTime() - 60_000)
  const future = new Date(now.getTime() + 60_000)
  await users.createOrUpdate({id: 1, monthlyDonationSats: 50, monthlyDonationNextAt: past})
  await users.createOrUpdate({id: 2, monthlyDonationLastHash: 'disabled-pending'})
  await users.createOrUpdate({
    id: 3,
    monthlyDonationSats: 50,
    monthlyDonationNextAt: future,
    monthlyDonationLastHash: 'future-pending',
  })
  await users.createOrUpdate({id: 4, monthlyDonationSats: 50, monthlyDonationNextAt: future})
  await users.createOrUpdate({id: 5})
  await users.createOrUpdate({id: 6, monthlyDonationSats: 0, monthlyDonationNextAt: past})
  expect(await users.countDueMonthlyDonations(now)).toBe(3)
  expect((await users.findDueMonthlyDonations(10, 0, now)).map(user => user.id).sort()).toEqual([
    1, 2, 3,
  ])
  await users.update(2, {monthlyDonationLastHash: null})
  expect(await users.countDueMonthlyDonations(now)).toBe(2)
  expect((await users.findDueMonthlyDonations(10, 0, now)).map(user => user.id).sort()).toEqual([
    1, 3,
  ])
})

for (const status of ['paid', 'pending', 'failed'] as const) {
  test(`late monthly ${status} settings cannot overwrite cron's completed schedule`, async () => {
    const users = repo()
    const now = new Date()
    const nextAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    await users.createOrUpdate({id: 1, monthlyDonationSats: 50, monthlyDonationNextAt: nextAt})
    const before = await users.getOrThrow(1)
    const updated = await users.updateMonthlyDonationIfDue(
      1,
      status === 'failed' ? null : 'paid-hash',
      {
        monthlyDonationSats: 100,
        monthlyDonationNextAt: status === 'paid' ? nextAt : now,
        ...(status === 'paid'
          ? {monthlyDonationLastHash: null, monthlyDonationExpiresAt: null}
          : {}),
      },
      now,
    )
    expect(updated).toBeUndefined()
    expect(await users.getOrThrow(1)).toEqual(before)
  })
}

test('monthly settings update only the due period with the expected hash', async () => {
  const users = repo()
  const now = new Date()
  await users.createOrUpdate({id: 1, monthlyDonationLastHash: 'in-flight'})
  const settings = {monthlyDonationSats: 50, monthlyDonationNextAt: now}
  expect(await users.updateMonthlyDonationIfDue(1, null, settings, now)).toBeUndefined()
  expect(await users.updateMonthlyDonationIfDue(1, 'other', settings, now)).toBeUndefined()
  expect(await users.updateMonthlyDonationIfDue(1, 'in-flight', settings, now)).toMatchObject({
    monthlyDonationSats: 50,
    monthlyDonationLastHash: 'in-flight',
  })
  expect(
    await users.updateMonthlyDonationIfDue(
      1,
      'in-flight',
      {
        ...settings,
        monthlyDonationNextAt: new Date(now.getTime() + 60_000),
        monthlyDonationLastHash: null,
        monthlyDonationExpiresAt: null,
      },
      now,
    ),
  ).toMatchObject({monthlyDonationLastHash: null, monthlyDonationExpiresAt: null})
})
