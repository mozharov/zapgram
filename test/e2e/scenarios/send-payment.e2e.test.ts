import {afterEach, beforeEach, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {conversationsTable, usersTable} from '@infra/db/schema.js'
import {creatingInvoice} from '@modules/invoices/telegram/conversations/creating-invoice.js'
import {staticCallback} from '@telegram/callback-data.js'
import {encode, toWords} from 'bech32'
import {expectNoConversations, expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import {USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {privateCallback, privateCommand, privateText, type TestUpdate} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['send-payment']

/**
 * One Send prompt. Payment engines stay separate; nothing moves before confirm.
 * `@username` outside this wizard is ordinary text.
 */

const AMOUNT = 30

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
})

afterEach(async () => {
  server?.stop()
  server = undefined
  await e2e.dispose()
})

test('an existing user is paid only after confirm, and cancel pays nothing', async () => {
  await seedRecipient()
  credit(USER_A, 1_000)
  const before = await snapshot(e2e)
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_b'))
  await e2e.send(privateText(String(AMOUNT)))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Nothing is sent until you confirm/)
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/@user_b/)
  expect(outgoing()).toHaveLength(0)
  const confirmId = requiredMessageId()

  await e2e.send(privateCallback(staticCallback.cancel, {messageId: confirmId}))
  expect(visibleHtml(e2e.tg.last('editMessageText'))).toMatch(/Wallet/)
  expect(outgoing()).toHaveLength(0)
  await expectNoConversations(e2e.db)
  expectLedgerBalanced(before, await snapshot(e2e))

  replyRecipient()
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_b'))
  await e2e.send(privateText(String(AMOUNT)))
  await e2e.send(confirm())

  expect(outgoing()).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: '100002 wallet', sats: AMOUNT, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees', sats: 0, times: 0})
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('a second confirm and a confirm after restart pay once', async () => {
  await e2e.dispose()
  e2e = await createE2E({mode: 'file'})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedRecipient()
  credit(USER_A, 1_000)
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_b'))
  await e2e.send(privateText(String(AMOUNT)))
  const confirmId = requiredMessageId()
  expect(outgoing()).toHaveLength(0)

  await e2e.restart()
  const first = privateCallback('confirm-send', {messageId: confirmId})
  const second = privateCallback('confirm-send', {messageId: confirmId})
  await Promise.all([e2e.send(first), e2e.send(second)])

  expect(outgoing()).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: '100002 wallet', sats: AMOUNT, times: 1})

  await e2e.send(privateCallback('confirm-send', {messageId: confirmId}))
  expect(outgoing()).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('a BOLT11 in Send pays only from the invoice confirmation', async () => {
  credit(USER_A, 1_000)
  const before = await snapshot(e2e)
  const invoice = foreignInvoice(AMOUNT)
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText(invoice.bolt11))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Confirm the payment/)
  expect(outgoing()).toHaveLength(0)
  await e2e.send(privateCallback('internal', {messageId: requiredMessageId()}))

  expect(outgoing()).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: 'master', sats: AMOUNT, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees', sats: 0, times: 0})
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('an LNURL custom amount and a fixed amount pay only after confirmation', async () => {
  credit(USER_A, 1_000)
  server = startServer({min: 10_000, max: 100_000})
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText(server.lnurl))
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/from <b>10<\/b> to <b>100<\/b>/)
  expect(server.hits.callback).toBe(0)
  await e2e.send(privateText('5'))
  expect(server.hits.callback).toBe(0)
  expect(outgoing()).toHaveLength(0)
  await e2e.send(privateText(String(AMOUNT)))
  expect(server.hits.callback).toBe(1)
  expect(outgoing()).toHaveLength(0)
  await e2e.send(privateCallback('internal', {messageId: requiredMessageId()}))
  expect(outgoing()).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: 'master', sats: AMOUNT, times: 1})

  server.stop()
  server = startServer({min: 20_000, max: 20_000})
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText(server.lnurl))
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/asks for 20 sats/)
  await e2e.send(privateText('20'))
  expect(outgoing()).toHaveLength(1)
  await e2e.send(privateCallback('internal', {messageId: requiredMessageId()}))
  expect(outgoing()).toHaveLength(2)
  expect(
    e2e.ln.state.payments.filter(
      payment => !payment.out && payment.paid && payment.amountMsat === 20_000,
    ),
  ).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('a lightning address is not a username and pays nothing when the recipient is unreachable', async () => {
  credit(USER_A, 1_000)
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('bob@localhost'))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Nothing was paid/)
  expect(String(e2e.tg.last('sendMessage')?.text)).not.toMatch(/Invalid username/)
  expect(outgoing()).toHaveLength(0)
  expectNoErrors(e2e.logs)
})

test('self and unknown usernames do not pay or create a wallet', async () => {
  const beforeUsers = (await e2e.db.select().from(usersTable)).length
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_a'))
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/can't send sats to yourself/)
  await e2e.send(privateText('@missing_user'))
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/doesn't have a ZapGram wallet/)
  expect((await e2e.db.select().from(usersTable)).length).toBe(beforeUsers)
  expect(outgoing()).toHaveLength(0)
  expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('an amount the wallet cannot cover pays nothing', async () => {
  await seedRecipient()
  credit(USER_A, 10)
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_b'))
  await e2e.send(privateText('11'))

  expect(joinedText()).toMatch(/Insufficient funds/)
  expect(outgoing()).toHaveLength(0)
})

test('@username outside Send does not transfer and does not swallow commands', async () => {
  await seedRecipient()
  credit(USER_A, 1_000)
  await e2e.send(privateText('@user_b'))

  expect(joinedText()).toMatch(/This is a Lightning wallet/)
  expect(outgoing()).toHaveLength(0)
  await expectNoConversations(e2e.db)

  await e2e.send(privateCommand('/wallet'))
  expect(visibleHtml(e2e.tg.last('sendRichMessage'))).toMatch(/Wallet/)

  await e2e.send(privateCallback(staticCallback.createInvoice))
  await e2e.send(privateText('@user_b'))
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Invalid amount/)
  expect(outgoing()).toHaveLength(0)
  expect(await conversationNames()).toEqual([creatingInvoice.name])
  expectNoErrors(e2e.logs)
})

const METADATA = JSON.stringify([
  ['text/plain', 'Pay Alice'],
  ['text/identifier', 'alice@example.com'],
])

type LnurlServer = {
  lnurl: string
  hits: {callback: number}
  stop: () => void
}

let server: LnurlServer | undefined

function startServer(range: {min: number; max: number}): LnurlServer {
  const hits = {callback: 0}
  let port = 0
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') {
        return Response.json({
          tag: 'payRequest',
          callback: `http://127.0.0.1:${port}/callback`,
          minSendable: range.min,
          maxSendable: range.max,
          metadata: METADATA,
        })
      }
      hits.callback += 1
      const sats = Number(url.searchParams.get('amount')) / 1000
      const hash = createHash('sha256').update(METADATA).digest('hex')
      const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
      if (!master) throw new Error('Fake LNbits master wallet not found')
      const invoice = e2e.ln.state.createInvoice({
        wallet: master,
        sats,
        memo: '',
        expirySec: 3600,
        descriptionHash: hash,
      })
      return Response.json({pr: invoice.bolt11})
    },
  })
  if (http.port === undefined) throw new Error('LNURL test server has no port')
  port = http.port
  return {
    lnurl: encode('lnurl', toWords(Buffer.from(`http://127.0.0.1:${port}/pay`)), 5000),
    hits,
    stop() {
      http.stop(true)
    },
  }
}

function seedRecipient(): Promise<unknown> {
  replyRecipient()
  return seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
}

function replyRecipient(): void {
  e2e.tg.reply('getChat', {id: USER_B, type: 'private', username: 'user_b', first_name: 'User B'})
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function foreignInvoice(sats: number) {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake LNbits master wallet not found')
  return e2e.ln.state.createInvoice({
    wallet: master,
    sats,
    memo: 'issued elsewhere',
    expirySec: 3600,
  })
}

function outgoing() {
  return e2e.ln.state.payments.filter(payment => payment.out)
}

function confirm(): TestUpdate {
  return privateCallback('confirm-send', {messageId: requiredMessageId()})
}

function requiredMessageId(): number {
  const messageId = e2e.tg.lastMessageId('editMessageText')
  if (messageId === undefined) throw new Error('Expected an edited wizard message')
  return messageId
}

function visibleHtml(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ''
  if (typeof payload.text === 'string') return payload.text
  const rich = payload.rich_message
  if (rich && typeof rich === 'object' && !Array.isArray(rich) && 'html' in rich) {
    return String(rich.html)
  }
  return ''
}

function joinedText(): string {
  return [...e2e.tg.of('sendMessage'), ...e2e.tg.of('editMessageText')]
    .map(call => String(call.text))
    .join('\n')
}

async function conversationNames(): Promise<string[]> {
  const rows = await e2e.db.select().from(conversationsTable)
  const state = rows[0]?.state
  if (!state || typeof state !== 'object') return []
  return Object.keys(state)
}
