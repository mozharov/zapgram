import {afterEach, beforeEach, expect, test} from 'bun:test'
import {broadcastsTable} from '@infra/db/schema.js'
import {broadcastConfirmRoute, broadcastLocaleRoute} from '@telegram/callback-data.js'
import {eq} from 'drizzle-orm'
import {expectNoErrors} from '../asserts.js'
import {OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {
  privateCallback,
  privateCommand,
  privateMyChatMember,
  privateText,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.broadcast

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({
    env: {ADMIN_TELEGRAM_IDS: String(OWNER)},
  })
})

afterEach(async () => {
  await e2e.dispose()
})

test('admin /broadcast en: copyMessage to en users only, excludes admin', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner', languageCode: 'en'})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'A', languageCode: 'en'})
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'B', languageCode: 'ru'})

  await e2e.send(privateCommand('/broadcast', {from: {id: OWNER, username: 'owner'}}))
  expect(
    e2e.tg.of('sendMessage').some(c => /Broadcast|Рассылка|language|язык/i.test(String(c.text))),
  ).toBe(true)

  await e2e.send(
    privateCallback(broadcastLocaleRoute.build({locale: 'en'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )

  await e2e.send(
    privateText('ZapGram update: on-chain joins are live', {
      from: {id: OWNER, username: 'owner'},
    }),
  )

  await e2e.send(
    privateCallback(broadcastConfirmRoute.build({action: 'yes'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )

  // Conversation kicks processQueue; cron job is the durable path — run both for determinism.
  await e2e.jobs.processBroadcasts()
  // Second pass no-ops when already completed.
  await e2e.jobs.processBroadcasts()

  const copies = e2e.tg.of('copyMessage')
  const toA = copies.filter(c => Number(c.chat_id) === USER_A)
  const toB = copies.filter(c => Number(c.chat_id) === USER_B)
  const toOwner = copies.filter(c => Number(c.chat_id) === OWNER)
  expect(toA.length).toBe(1)
  expect(toB.length).toBe(0)
  expect(toOwner.length).toBe(0)

  const report = e2e.tg
    .of('sendMessage')
    .filter(c => Number(c.chat_id) === OWNER)
    .map(c => String(c.text))
  expect(report.some(t => /finished|Sent:/i.test(t) && /1/.test(t))).toBe(true)

  const rows = await e2e.db.select().from(broadcastsTable)
  expect(rows.length).toBe(1)
  expect(rows[0]?.status).toBe('completed')
  expect(rows[0]?.sentCount).toBe(1)
  expectNoErrors(e2e.logs)
})

test('non-admin /broadcast is silent', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', languageCode: 'en'})
  const before = e2e.tg.of('sendMessage').length

  await e2e.send(privateCommand('/broadcast', {from: {id: USER_A, username: 'user_a'}}))

  expect(e2e.tg.of('sendMessage').length).toBe(before)
  expect(e2e.tg.of('copyMessage').length).toBe(0)
})

test('private my_chat_member block/unblock toggles users.bot_blocked', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', languageCode: 'en'})

  await e2e.send(privateMyChatMember(true, {from: {id: USER_A, username: 'user_a'}}))
  expect((await e2e.container.users.findById(USER_A))?.botBlocked).toBe(true)

  await e2e.send(privateMyChatMember(false, {from: {id: USER_A, username: 'user_a'}}))
  expect((await e2e.container.users.findById(USER_A))?.botBlocked).toBe(false)
})

test('blocked users are not snapshotted into a new broadcast', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', languageCode: 'en'})
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    languageCode: 'en',
    botBlocked: true,
  })

  await e2e.send(privateCommand('/broadcast', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastLocaleRoute.build({locale: 'en'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.send(privateText('hi', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastConfirmRoute.build({action: 'yes'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.jobs.processBroadcasts()

  expect(e2e.tg.of('copyMessage').filter(c => Number(c.chat_id) === USER_A).length).toBe(0)
  const [row] = await e2e.db.select().from(broadcastsTable).where(eq(broadcastsTable.locale, 'en'))
  expect(row?.totalCount).toBe(0)
  expect(row?.status).toBe('completed')
})

test('copyMessage chat not found marks user bot_blocked and skips next broadcast', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', languageCode: 'en'})
  await seedUser(e2e, {id: USER_A, username: 'user_a', languageCode: 'en'})

  e2e.tg.fail('copyMessage', {
    error_code: 400,
    description: 'Bad Request: chat not found',
  })

  await e2e.send(privateCommand('/broadcast', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastLocaleRoute.build({locale: 'en'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.send(privateText('hi', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastConfirmRoute.build({action: 'yes'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.jobs.processBroadcasts()

  expect((await e2e.container.users.findById(USER_A))?.botBlocked).toBe(true)
  const [first] = await e2e.db
    .select()
    .from(broadcastsTable)
    .where(eq(broadcastsTable.locale, 'en'))
  expect(first?.skippedCount).toBe(1)
  expect(first?.sentCount).toBe(0)

  // Second campaign must not snapshot the unreachable user.
  await e2e.send(privateCommand('/broadcast', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastLocaleRoute.build({locale: 'en'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.send(privateText('again', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastConfirmRoute.build({action: 'yes'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.jobs.processBroadcasts()

  const rows = await e2e.db.select().from(broadcastsTable).where(eq(broadcastsTable.locale, 'en'))
  const second = rows.find(r => r.id !== first?.id)
  expect(second?.totalCount).toBe(0)
  expect(e2e.tg.of('copyMessage').filter(c => Number(c.chat_id) === USER_A).length).toBe(1)
})

test('private command clears bot_blocked so user can receive broadcasts again', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', languageCode: 'en'})
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    languageCode: 'en',
    botBlocked: true,
  })

  await e2e.send(privateCommand('/wallet', {from: {id: USER_A, username: 'user_a'}}))
  expect((await e2e.container.users.findById(USER_A))?.botBlocked).toBe(false)

  await e2e.send(privateCommand('/broadcast', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastLocaleRoute.build({locale: 'en'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.send(privateText('welcome back', {from: {id: OWNER, username: 'owner'}}))
  await e2e.send(
    privateCallback(broadcastConfirmRoute.build({action: 'yes'}), {
      from: {id: OWNER, username: 'owner'},
    }),
  )
  await e2e.jobs.processBroadcasts()

  expect(e2e.tg.of('copyMessage').filter(c => Number(c.chat_id) === USER_A).length).toBe(1)
})

test('private callback clears bot_blocked', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    languageCode: 'en',
    botBlocked: true,
  })

  await e2e.send(privateCallback('wallet', {from: {id: USER_A, username: 'user_a'}}))
  expect((await e2e.container.users.findById(USER_A))?.botBlocked).toBe(false)
})
