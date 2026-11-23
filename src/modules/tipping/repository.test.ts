import {expect, test} from 'bun:test'
import {tipCommandsTable} from '@infra/db/schema.js'
import {createTipCommandRepository} from '@modules/tipping/repository.js'
import {createTestDb} from '@test/helpers/db.js'

const command = {chatId: -100, fromUserId: 1, messageId: 42, date: 1000}

test('competing claims reserve a tip command exactly once', async () => {
  const db = createTestDb()
  const first = createTipCommandRepository(db)
  const second = createTipCommandRepository(db)
  const claims = await Promise.all([first.claim(command), second.claim(command)])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(await db.select().from(tipCommandsTable)).toEqual([command])
  expect(await createTipCommandRepository(db).claim(command)).toBe(false)
})

for (const field of ['chatId', 'fromUserId', 'messageId', 'date'] as const) {
  test(`a different ${field} is a separate tip command`, async () => {
    const tips = createTipCommandRepository(createTestDb())
    expect(await tips.claim(command)).toBe(true)
    expect(await tips.claim({...command, [field]: command[field] + 1})).toBe(true)
  })
}
