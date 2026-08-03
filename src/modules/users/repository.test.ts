import {expect, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

function repo() {
  return createUserRepository(createTestDb())
}

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
