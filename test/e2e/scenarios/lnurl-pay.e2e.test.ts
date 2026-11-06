import {afterAll, afterEach, beforeEach, expect, mock, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {conversationsTable} from '@infra/db/schema.js'
import {NostrWallet as RealNostrWallet} from '@infra/nostr/wallet.js'
import {staticCallback} from '@telegram/callback-data.js'
import {encode, toWords} from 'bech32'
import {expectNoConversations, expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['lnurl-pay']

import {USER_A} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {privateCallback, privateText, type TestUpdate} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectLedgerBalanced, snapshot} from '../state.js'

/**
 * Lightning address and LNURL-pay. The recipient is a local HTTP server speaking LNURL-pay.
 * LNbits pays the bolt11 the callback returns. NWC is the only place an e2e may mock a wallet.
 * Nothing is paid until the existing invoice confirmation.
 */

const METADATA = JSON.stringify([
  ['text/plain', 'Pay Alice'],
  ['text/identifier', 'alice@example.com'],
])
const HASH = createHash('sha256').update(METADATA).digest('hex')
const NWC_URL = `nostr+walletconnect://${'aa'.repeat(32)}?relay=wss://relay.example&secret=${'bb'.repeat(32)}`
const AMOUNT = 30

type Mode = 'ok' | 'bad-json' | 'http-error' | 'timeout' | 'amount' | 'hash' | 'callback-error'

type NwcCall = {method: string; args: unknown[]}

const nwcCalls: NwcCall[] = []
let nwcBalanceMsat = 5_000_000
let e2e: E2E

class FakeNostrWallet {
  nwcUrl: string

  constructor(nwcUrl: string, _memoFooter = '', _log?: unknown) {
    this.nwcUrl = nwcUrl
    nwcCalls.push({method: 'ctor', args: [nwcUrl]})
  }

  async getBalance(): Promise<number> {
    nwcCalls.push({method: 'getBalance', args: []})
    return nwcBalanceMsat
  }

  async payInvoice(invoice: string): Promise<void> {
    nwcCalls.push({method: 'payInvoice', args: [invoice]})
    const payment = e2e.ln.state.payments.find(
      candidate => candidate.bolt11 === invoice && !candidate.out,
    )
    if (!payment || payment.paid) return
    const wallet = e2e.ln.state.wallets.find(candidate => candidate.id === payment.walletId)
    if (!wallet) return
    payment.paid = true
    wallet.balanceMsat += payment.amountMsat
  }

  async createInvoice(msats: number, memo = ''): Promise<{invoice: string; payment_hash: string}> {
    nwcCalls.push({method: 'createInvoice', args: [msats, memo]})
    return {invoice: 'lnbc-fake-nwc', payment_hash: 'fake-nwc-hash'}
  }

  async lookupInvoice(invoice: string): Promise<{preimage: string | null; fees_paid: number}> {
    nwcCalls.push({method: 'lookupInvoice', args: [invoice]})
    return {preimage: 'fake-preimage', fees_paid: 0}
  }
}

mock.module('@infra/nostr/wallet.js', () => ({
  NostrWallet: FakeNostrWallet,
}))

afterAll(() => {
  mock.module('@infra/nostr/wallet.js', () => ({
    NostrWallet: RealNostrWallet,
  }))
})

type LnurlServer = {
  lnurl: string
  hits: {metadata: number; callback: number; comments: number}
  stop: () => void
}

let server: LnurlServer | undefined

beforeEach(async () => {
  nwcCalls.length = 0
  nwcBalanceMsat = 5_000_000
  e2e = await createE2E({env: {BOT_USERNAME: 'zap_gram_bot'}})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', languageCode: 'en'})
})

afterEach(async () => {
  server?.stop()
  server = undefined
  await e2e.dispose()
})

test('an LNURL pay confirms, then pays once from the ZapGram wallet', async () => {
  server = startServer('ok')
  credit(USER_A, 1_000)
  const before = await snapshot(e2e)
  const pasted = privateText(server.lnurl)

  await e2e.send(pasted)
  const offer = e2e.tg.last('sendMessage')
  expect(String(offer?.text)).toMatch(/Lightning address or LNURL/)
  expect(keyboardOf(offer)).toHaveLength(1)
  const payData = keyboardOf(offer)[0] ?? ''
  const offerId = requiredMessageId('sendMessage')
  expect(server.hits).toEqual({metadata: 0, callback: 0, comments: 0})

  await e2e.send(payCallback(payData, offerId, pasted))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/from <b>10<\/b> to <b>100<\/b>/)
  expect(server.hits.metadata).toBe(1)
  expect(server.hits.callback).toBe(0)
  expect(outgoing()).toHaveLength(0)

  await e2e.send(privateText('1'))
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/whole number of sats from 10 to 100/)
  expect(server.hits.callback).toBe(0)
  expect(outgoing()).toHaveLength(0)

  await e2e.send(privateText(String(AMOUNT)))

  expect(joinedText()).toMatch(/Pay Alice/)
  expect(joinedText()).toMatch(/Confirm the payment/)
  expect(server.hits.callback).toBe(1)
  expect(server.hits.comments).toBe(0)
  expect(outgoing()).toHaveLength(0)
  const reviewId = requiredMessageId('sendMessage')

  await e2e.send(privateCallback('internal', {messageId: reviewId}))

  expect(outgoing()).toHaveLength(1)
  expect(outgoing()[0]?.amountMsat).toBe(AMOUNT * 1000)
  expectPayoutsExactly(e2e.ln, {toWallet: 'master', sats: AMOUNT, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees', sats: 0, times: 0})
  expectLedgerBalanced(before, await snapshot(e2e))
  await expectNoConversations(e2e.db)

  await e2e.send(payCallback(payData, offerId, pasted))

  expect(outgoing()).toHaveLength(1)
  expect(String(e2e.tg.last('answerCallbackQuery')?.text)).toMatch(/no longer active/)
  expectNoErrors(e2e.logs)
})

test('the same LNURL pays once from NWC after confirmation', async () => {
  server = startServer('ok')
  await e2e.container.users.update(USER_A, {nwcUrl: NWC_URL})
  const pasted = privateText(server.lnurl)
  await e2e.send(pasted)
  const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
  const offerId = requiredMessageId('sendMessage')

  await e2e.send(payCallback(payData, offerId, pasted))
  await e2e.send(privateText(String(AMOUNT)))

  expect(joinedText()).toMatch(/NWC wallet/)
  expect(outgoing()).toHaveLength(0)
  expect(nwcCalls.filter(call => call.method === 'payInvoice')).toHaveLength(0)
  const reviewId = requiredMessageId('sendMessage')

  await e2e.send(privateCallback('nwc', {messageId: reviewId}))

  expect(nwcCalls.filter(call => call.method === 'payInvoice')).toHaveLength(1)
  expect(nwcCalls.filter(call => call.method === 'lookupInvoice')).toHaveLength(1)
  expect(outgoing()).toHaveLength(0)
  expect(e2e.ln.state.payments.filter(payment => payment.paid && !payment.out)).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees', sats: 0, times: 0})

  await e2e.send(privateCallback('nwc', {messageId: reviewId}))

  expect(nwcCalls.filter(call => call.method === 'payInvoice')).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('Pay still loads the LNURL after a restart, then one confirmation pays once', async () => {
  await e2e.dispose()
  e2e = await createE2E({mode: 'file', env: {BOT_USERNAME: 'zap_gram_bot'}})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', languageCode: 'en'})
  server = startServer('ok')
  credit(USER_A, 1_000)
  const before = await snapshot(e2e)
  const pasted = privateText(server.lnurl)
  await e2e.send(pasted)
  const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
  const offerId = requiredMessageId('sendMessage')

  await e2e.restart()
  await e2e.send(payCallback(payData, offerId, pasted))
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Enter the amount/)
  expect(server.hits.metadata).toBe(1)

  await e2e.restart()
  await e2e.send(privateText(String(AMOUNT)))
  expect(server.hits.callback).toBe(1)
  expect(outgoing()).toHaveLength(0)
  const reviewId = requiredMessageId('sendMessage')

  await e2e.send(privateCallback('internal', {messageId: reviewId}))

  expect(outgoing()).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: 'master', sats: AMOUNT, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees', sats: 0, times: 0})
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('two Pay clicks open one amount prompt and pay nothing', async () => {
  server = startServer('ok')
  credit(USER_A, 1_000)
  const pasted = privateText(server.lnurl)
  await e2e.send(pasted)
  const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
  const offerId = requiredMessageId('sendMessage')

  await Promise.all([
    e2e.send(payCallback(payData, offerId, pasted)),
    e2e.send(payCallback(payData, offerId, pasted)),
  ])

  const prompts = e2e.tg
    .of('sendMessage')
    .map(call => String(call.text))
    .filter(text => /Enter the amount/.test(text))
  expect(prompts).toHaveLength(1)
  expect(server.hits.metadata).toBe(1)
  expect(server.hits.callback).toBe(0)
  expect(outgoing()).toHaveLength(0)
  expect(
    e2e.tg.of('answerCallbackQuery').some(call => /no longer active/.test(String(call.text ?? ''))),
  ).toBe(true)
  expectNoErrors(e2e.logs)
})

test('a failed offer delete keeps the step and does not fetch the recipient', async () => {
  server = startServer('ok')
  credit(USER_A, 1_000)
  await e2e.send(privateCallback(staticCallback.sendToUser))
  const pasted = privateText(server.lnurl)
  await e2e.send(pasted)
  const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
  const offerId = requiredMessageId('sendMessage')
  e2e.tg.fail('deleteMessage', {error_code: 500, description: 'Internal Server Error'})

  await e2e.send(payCallback(payData, offerId, pasted))

  expect(String(e2e.tg.last('answerCallbackQuery')?.text)).toMatch(/Try again/)
  expect(server.hits.metadata).toBe(0)
  expect(outgoing()).toHaveLength(0)
  expect(await conversationNames()).toEqual(['sendingToUser'])

  await e2e.send(payCallback(payData, offerId, pasted))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Enter the amount/)
  expect(server.hits.callback).toBe(0)
  expect(outgoing()).toHaveLength(0)
  expectNoErrors(e2e.logs)
})

test('Back on an LNURL returns to the step and does not contact the recipient', async () => {
  server = startServer('ok')
  await e2e.send(privateCallback(staticCallback.sendToUser))
  await e2e.send(privateText(server.lnurl))
  const backData = keyboardOf(e2e.tg.last('sendMessage'))[1] ?? ''
  const offerId = requiredMessageId('sendMessage')

  await e2e.send(privateCallback(backData, {messageId: offerId}))
  await e2e.send(privateText('not-a-user'))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Invalid username/)
  expect(server.hits).toEqual({metadata: 0, callback: 0, comments: 0})
  expect(outgoing()).toHaveLength(0)
  expect(await conversationNames()).toEqual(['sendingToUser'])
  expectNoErrors(e2e.logs)
})

for (const failure of [
  {mode: 'bad-json' as const, text: /unexpected response/, beforeAmount: true},
  {mode: 'http-error' as const, text: /could not complete the payment/, beforeAmount: true},
  {mode: 'amount' as const, text: /does not match the amount/, beforeAmount: false},
  {mode: 'hash' as const, text: /does not match the recipient/, beforeAmount: false},
  {mode: 'callback-error' as const, text: /could not complete the payment/, beforeAmount: false},
]) {
  test(`LNURL ${failure.mode} does not pay`, async () => {
    server = startServer(failure.mode)
    credit(USER_A, 1_000)
    const pasted = privateText(server.lnurl)
    await e2e.send(pasted)
    const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
    const offerId = requiredMessageId('sendMessage')

    await e2e.send(payCallback(payData, offerId, pasted))
    if (!failure.beforeAmount) await e2e.send(privateText(String(AMOUNT)))

    expect(joinedText()).toMatch(failure.text)
    expect(joinedText()).toMatch(/Nothing was paid/)
    expect(outgoing()).toHaveLength(0)
    expect(nwcCalls.filter(call => call.method === 'payInvoice')).toHaveLength(0)
    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('a recipient that never answers does not get paid', async () => {
  server = startServer('timeout')
  credit(USER_A, 1_000)
  const pasted = privateText(server.lnurl)
  await e2e.send(pasted)
  const payData = keyboardOf(e2e.tg.last('sendMessage'))[0] ?? ''
  const offerId = requiredMessageId('sendMessage')

  await e2e.send(payCallback(payData, offerId, pasted))

  expect(joinedText()).toMatch(/did not answer in time/)
  expect(joinedText()).toMatch(/Nothing was paid/)
  expect(outgoing()).toHaveLength(0)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
}, 20_000)

function startServer(mode: Mode): LnurlServer {
  const hits = {metadata: 0, callback: 0, comments: 0}
  const closing = new AbortController()
  let port = 0
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/pay') {
        hits.metadata += 1
        if (mode === 'timeout') {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 30_000)
            const done = () => {
              clearTimeout(timer)
              resolve(undefined)
            }
            closing.signal.addEventListener('abort', done)
            request.signal.addEventListener('abort', done)
          })
          return new Response('late', {status: 504})
        }
        if (mode === 'http-error') return new Response('down', {status: 500})
        if (mode === 'bad-json') return Response.json({nope: true})
        return Response.json({
          tag: 'payRequest',
          callback: `http://127.0.0.1:${port}/invoice`,
          minSendable: 10_000,
          maxSendable: 100_000,
          metadata: METADATA,
          commentAllowed: 40,
        })
      }
      hits.callback += 1
      if (url.searchParams.has('comment')) hits.comments += 1
      if (mode === 'callback-error') return new Response('no', {status: 503})
      const asked = Number(url.searchParams.get('amount')) / 1000
      const sats = mode === 'amount' ? asked + 1 : asked
      const descriptionHash =
        mode === 'hash' ? createHash('sha256').update('nope').digest('hex') : HASH
      const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
      if (!master) throw new Error('Fake LNbits master wallet not found')
      const invoice = e2e.ln.state.createInvoice({
        wallet: master,
        sats,
        memo: 'Pay Alice',
        expirySec: 3600,
        descriptionHash,
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
      closing.abort()
      http.stop(true)
    },
  }
}

function payCallback(data: string, offerId: number, pasted: TestUpdate): TestUpdate {
  const update = privateCallback(data, {messageId: offerId})
  const message = update.callback_query?.message
  const source = pasted.message
  if (!message || !source?.text) throw new Error('pay callback is missing its reply')
  Object.assign(message, {
    reply_to_message: {
      message_id: source.message_id,
      date: source.date,
      text: source.text,
      from: source.from,
      chat: source.chat,
    },
  })
  return update
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function outgoing() {
  return e2e.ln.state.payments.filter(payment => payment.out)
}

function keyboardOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function requiredMessageId(method: string): number {
  const messageId = e2e.tg.lastMessageId(method)
  if (messageId === undefined) throw new Error(`No ${method} result`)
  return messageId
}

function joinedText(): string {
  return e2e.tg.calls.map(call => String(call.payload.text ?? '')).join('\n')
}

async function conversationNames(): Promise<string[]> {
  const rows = await e2e.db.select().from(conversationsTable)
  expect(rows).toHaveLength(1)
  const state = rows[0]?.state
  if (!state || typeof state !== 'object') throw new Error('conversation state missing')
  return Object.keys(state)
}
