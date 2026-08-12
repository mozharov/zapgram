import {afterEach, beforeEach, expect, test} from 'bun:test'
import {usersTable} from '@infra/db/schema.js'
import {privateCommand} from './fixtures/updates.js'
import {createE2E, type E2E} from './harness.js'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('/start passes through the real container and composer', async () => {
  await e2e.send(privateCommand('/start'))

  const calls = e2e.tg.of('sendRichMessage')
  expect(calls).toHaveLength(1)
  expect(calls.every(call => Number(call.chat_id) === 100001)).toBe(true)
  expect(await e2e.db.select().from(usersTable)).toHaveLength(1)
  expect(e2e.logs.filter(log => log.level === 'error')).toEqual([])
})

test('a disposed world does not prevent the next world from starting', async () => {
  await e2e.dispose()
  e2e = await createE2E()

  await e2e.send(privateCommand('/help'))
  expect(e2e.tg.of('sendRichMessage')).toHaveLength(1)
})

test('restart requires file mode', async () => {
  await expect(e2e.restart()).rejects.toThrow("createE2E({mode: 'file'})")
})

test('file mode restart rebuilds the container on the same database', async () => {
  await e2e.dispose()
  e2e = await createE2E({mode: 'file'})
  await e2e.send(privateCommand('/help'))
  const firstContainer = e2e.container

  const before = [...e2e.tg.calls]

  await e2e.restart()

  expect(e2e.container).not.toBe(firstContainer)
  expect(await e2e.db.select().from(usersTable)).toHaveLength(1)
  // The restart keeps the Bot API history and adds no getMe of its own.
  expect(e2e.tg.calls).toEqual(before)
  expect(e2e.tg.of('getMe')).toEqual([])
})
