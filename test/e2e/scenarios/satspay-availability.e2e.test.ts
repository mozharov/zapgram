import {afterEach, beforeEach, expect, test} from 'bun:test'
import {payOnchainRoute} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedActivePaidChat, seedUser} from '../fixtures/seed.js'
import {chatJoinRequest, privateCallback} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['satspay-availability']

const PRICE = 1000
const MASTERPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'
const DOWN = 'SatsPay в LNbits перестал отвечать'
const BACK = 'SatsPay снова работает'
const EXTENSION_DOWN = 'On-chain is temporarily unavailable. You can pay with Lightning.'
const CREATE_FAILED = 'Could not create an on-chain payment. Please try again later.'
const DISABLED_BODY = {detail: "Extension 'satspay' disabled"}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedPeople()
})

afterEach(async () => {
  await e2e.dispose()
})

test('a healthy SatsPay shows Lightning and Bitcoin', async () => {
  await seedOnchainChat()
  await e2e.send(joinUpdate())
  expect(buttonRows(e2e.tg.last('sendRichMessage'))).toEqual([['⚡ Lightning', '⛓ Bitcoin']])
  expect(probeGets()).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('a disabled extension hides Bitcoin and does not create a charge', async () => {
  await seedOnchainChat()
  e2e.ln.state.failAlways(
    {method: 'GET', path: '/satspay/api/v1'},
    {status: 404, body: DISABLED_BODY},
  )
  await e2e.send(joinUpdate())
  expect(buttonRows(e2e.tg.last('sendRichMessage'))).toEqual([['⚡ Lightning']])
  expect(chargePosts()).toHaveLength(0)
  expect(probeGets().length).toBeGreaterThan(0)
})

test('a chat that is not on-chain does not probe SatsPay', async () => {
  await seedActivePaidChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E lightning chat',
    price: PRICE,
  })
  await e2e.send(joinUpdate())
  expect(buttonRows(e2e.tg.last('sendRichMessage'))).toEqual([['⚡ Lightning']])
  expect(probeGets()).toHaveLength(0)
  expectNoErrors(e2e.logs)
})

test('a disabled charge tells the member and the admins once', async () => {
  await useAdmins()
  await seedOnchainChat()
  await e2e.send(joinUpdate())
  const messageId = requiredJoinMessageId()
  e2e.ln.state.failAlways(
    {method: 'POST', path: '/satspay/api/v1/charge'},
    {status: 404, body: DISABLED_BODY},
  )

  await tapOnchain(messageId)
  expect(e2e.tg.last('answerCallbackQuery')?.text).toBe(EXTENSION_DOWN)

  await e2e.send(joinUpdate())
  expect(buttonRows(e2e.tg.last('sendRichMessage'))).toEqual([['⚡ Lightning']])
  expect(notices(DOWN)).toHaveLength(1)
  expect(notices(DOWN)[0]?.reply_markup).toBeUndefined()

  await tapOnchain(messageId)
  expect(e2e.tg.last('answerCallbackQuery')?.text).toBe(EXTENSION_DOWN)
  expect(notices(DOWN)).toHaveLength(1)
})

test('a charge 500 keeps the create-failed toast and the Bitcoin button', async () => {
  await seedOnchainChat()
  await e2e.send(joinUpdate())
  e2e.ln.state.failAlways(
    {method: 'POST', path: '/satspay/api/v1/charge'},
    {status: 500, body: {detail: 'nope'}},
  )
  await tapOnchain(requiredJoinMessageId())
  expect(e2e.tg.last('answerCallbackQuery')?.text).toBe(CREATE_FAILED)

  await e2e.send(joinUpdate())
  expect(buttonRows(e2e.tg.last('sendRichMessage'))).toEqual([['⚡ Lightning', '⛓ Bitcoin']])
})

test('the hourly probe tells admins once when SatsPay goes down and once when it returns', async () => {
  await useAdmins()
  e2e.ln.state.failAlways(
    {method: 'GET', path: '/satspay/api/v1'},
    {status: 404, body: DISABLED_BODY},
  )
  await e2e.jobs.probeSatspay()
  await e2e.jobs.probeSatspay()
  expect(notices(DOWN)).toHaveLength(1)

  e2e.ln.state.clearFailures()
  await e2e.jobs.probeSatspay()
  expect(notices(BACK)).toHaveLength(1)
  await e2e.jobs.probeSatspay()
  expect(notices(DOWN)).toHaveLength(1)
  expect(notices(BACK)).toHaveLength(1)
})

async function useAdmins(): Promise<void> {
  await e2e.dispose()
  e2e = await createE2E({env: {ADMIN_TELEGRAM_IDS: String(OWNER)}})
  await seedPeople()
}

async function seedPeople(): Promise<void> {
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Owner', languageCode: 'en'})
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'en',
  })
}

async function seedOnchainChat(): Promise<void> {
  await e2e.container.chats.createOrUpdate({
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E on-chain chat',
    type: 'supergroup',
    price: PRICE,
    status: 'active',
    paymentType: 'one_time',
  })
  const enable = await e2e.container.onchainEnableService.enable(
    await e2e.container.chats.getOrThrow(CHAT_GROUP),
    MASTERPUB,
  )
  expect(enable.status).toBe('enabled')
}

function joinUpdate() {
  return chatJoinRequest('supergroup', {
    from: {id: USER_A},
    chat: {id: CHAT_GROUP, title: 'E2E on-chain chat'},
  })
}

async function tapOnchain(messageId: number): Promise<void> {
  await e2e.send(
    privateCallback(payOnchainRoute.build({chatId: CHAT_GROUP}), {
      from: {id: USER_A},
      messageId,
    }),
  )
}

function requiredJoinMessageId(): number {
  const id = e2e.tg.lastMessageId('sendRichMessage')
  if (id === undefined) throw new Error('join message missing')
  return id
}

function buttonRows(payload: {reply_markup?: unknown} | undefined): string[][] {
  const markup = payload?.reply_markup as {inline_keyboard?: {text?: string}[][]} | undefined
  return (markup?.inline_keyboard ?? []).map(row => row.map(button => button.text ?? ''))
}

function probeGets() {
  return e2e.ln.requests.filter(
    request => request.method === 'GET' && request.path === '/satspay/api/v1',
  )
}

function chargePosts() {
  return e2e.ln.requests.filter(
    request => request.method === 'POST' && request.path === '/satspay/api/v1/charge',
  )
}

function notices(text: string) {
  return e2e.tg.of('sendMessage').filter(call => call.text === text)
}
