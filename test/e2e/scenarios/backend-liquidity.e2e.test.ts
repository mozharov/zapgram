import {afterEach, beforeEach, expect, test} from 'bun:test'
import {SendPausedError} from '@core/errors/send-paused.js'
import {translate} from '@telegram/i18n/i18n.js'
import {mintInvoice} from '../fakes/bolt11.js'
import {CHAT_GROUP, USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {groupText, privateCallback, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['backend-liquidity']

/**
 * Outgoing LNbits pays stop before POST /api/v1/payments when the funding source cannot cover
 * the invoice plus its fee reserve. Incoming invoice creation is left alone.
 */

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({env: {LOG_LEVEL: 'info'}})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
})

afterEach(async () => {
  await e2e.dispose()
})

test('zero backend balance pauses a wallet payment without calling pay', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 100, description: 'empty backend'})
  const before = await snapshot(e2e)
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(privateCallback('internal', {messageId: requiredPromptMessageId()}))

  expect(messageTexts()).toContain(translate('error.send-paused', 'en'))
  expect(outgoingPaysSince(mark)).toEqual([])
  const after = await snapshot(e2e)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
  const paused = e2e.logs.filter(entry => String(entry.msg).includes('Outgoing payment paused'))
  expect(paused.length).toBeGreaterThan(0)
  expect(JSON.stringify(paused)).not.toContain(invoice.bolt11)
  expect(JSON.stringify(paused)).not.toContain(e2e.container.config.LNBITS_ADMIN_KEY)
})

test('enough backend balance pays the invoice', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 100_000_000
  const invoice = mintInvoice({sats: 100, description: 'funded backend'})
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(privateCallback('internal', {messageId: requiredPromptMessageId()}))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(pathsSince(mark)).toContain('GET /api/v1/status')
})

test('a failed balance check pauses without calling pay', async () => {
  credit(USER_A, 1000)
  const invoice = mintInvoice({sats: 100, description: 'status down'})
  const before = await snapshot(e2e)

  await e2e.send(privateText(invoice.bolt11))
  const mark = e2e.ln.requests.length
  e2e.ln.state.failNext(
    {method: 'GET', path: '/api/v1/status'},
    {status: 500, body: {detail: 'status down'}},
  )
  await e2e.send(privateCallback('internal', {messageId: requiredPromptMessageId()}))

  expect(messageTexts()).toContain(translate('error.send-paused', 'en'))
  expect(outgoingPaysSince(mark)).toEqual([])
  const after = await snapshot(e2e)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
})

test('the pause copy is Russian when the sender is Russian', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'ru',
  })
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 50, description: 'пусто'})

  await e2e.send(
    privateText(invoice.bolt11, {
      from: {id: USER_A, username: 'user_a', first_name: 'User A', language_code: 'ru'},
    }),
  )
  await e2e.send(
    privateCallback('internal', {
      messageId: requiredPromptMessageId(),
      from: {id: USER_A, username: 'user_a', first_name: 'User A', language_code: 'ru'},
    }),
  )

  expect(messageTexts()).toContain(translate('error.send-paused', 'ru'))
  expect(outgoingPaysSince(0)).toEqual([])
})

test('a group tip is paused for the sender only and does not pay', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const mark = e2e.ln.requests.length

  await e2e.send(groupText('/tip 21 @user_b'))

  const notice = e2e.tg.of('sendMessage').find(call => Number(call.chat_id) === CHAT_GROUP)
  expect(String(notice?.text)).toBe(translate('error.send-paused', 'en'))
  expect(Number(notice?.receiver_user_id)).toBe(USER_A)
  expect(outgoingPaysSince(mark)).toEqual([])
  expect(e2e.tg.of('sendMessage').some(call => Number(call.chat_id) === USER_B)).toBe(false)
})

test('the master wallet pay is paused without calling pay when the backend is empty', async () => {
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 10, description: 'owner payout'})
  const mark = e2e.ln.requests.length

  await expect(e2e.container.masterWallet.payInvoice(invoice.bolt11)).rejects.toBeInstanceOf(
    SendPausedError,
  )
  expect(outgoingPaysSince(mark)).toEqual([])
})

test('the master wallet pays when the backend covers the invoice and the reserve', async () => {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake master wallet not found')
  e2e.ln.state.credit(master.id, 100_000_000)
  e2e.ln.state.fundingSourceBalanceMsat = 100_000_000
  const invoice = mintInvoice({sats: 10, description: 'owner payout ok'})
  const mark = e2e.ln.requests.length

  const payment = await e2e.container.masterWallet.payInvoice(invoice.bolt11)

  expect(payment.amount).toBe(-10_000)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
})

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function requiredPromptMessageId(): number {
  const edited = e2e.tg.lastMessageId('editMessageText')
  if (edited !== undefined) return edited
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound text prompt message ID')
  return messageId
}

function outgoingPaysSince(mark: number) {
  return e2e.ln.requests.slice(mark).filter(request => {
    if (request.method !== 'POST' || request.path !== '/api/v1/payments') return false
    const body = request.body
    return Boolean(body && typeof body === 'object' && Reflect.get(body, 'out') === true)
  })
}

function pathsSince(mark: number): string[] {
  return e2e.ln.requests.slice(mark).map(request => `${request.method} ${request.path}`)
}

function messageTexts(): string[] {
  return e2e.tg.of('sendMessage').map(call => String(call.text))
}
