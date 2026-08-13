import {afterAll, afterEach, beforeEach, expect, mock, test} from 'bun:test'
import {conversationsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import {NostrWallet as RealNostrWallet} from '@infra/nostr/wallet.js'
import {staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedExpiringSubscription, seedUser} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  groupText,
  privateCallback,
  privateCommand,
  privateText,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.nwc

/**
 * NWC-positive branches of §7.3 and §7.5.
 *
 * `NostrWallet` dials real Nostr relays in its constructor, so this is the only scenario file
 * allowed to use `mock.module`. The fake settles LNbits invoices on `payInvoice` so tips and
 * subscription payments still move ledger money the way an external wallet would.
 */

const NWC_URL = `nostr+walletconnect://${'aa'.repeat(32)}?relay=wss://relay.example&secret=${'bb'.repeat(32)}`
const NWC_BALANCE_SATS = 5000
const TIP_SATS = 21
const PRICE = 1000

type NwcCall = {method: string; args: unknown[]}

const nwcCalls: NwcCall[] = []
let nwcBalanceMsat = NWC_BALANCE_SATS * 1000
let getBalanceShouldFail = false
let e2e: E2E

class FakeNostrWallet {
  nwcUrl: string

  constructor(nwcUrl: string, _memoFooter = '', _log?: unknown) {
    this.nwcUrl = nwcUrl
    nwcCalls.push({method: 'ctor', args: [nwcUrl]})
  }

  async getBalance(): Promise<number> {
    nwcCalls.push({method: 'getBalance', args: []})
    if (getBalanceShouldFail) throw new Error('NWC relay unavailable')
    return nwcBalanceMsat
  }

  async payInvoice(invoice: string): Promise<void> {
    nwcCalls.push({method: 'payInvoice', args: [invoice]})
    settleIncomingInvoice(invoice)
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

// Sole exception to the e2e “no mocks” rule — see plan P4 / step 4.13.
mock.module('@infra/nostr/wallet.js', () => ({
  NostrWallet: FakeNostrWallet,
}))

afterAll(() => {
  mock.module('@infra/nostr/wallet.js', () => ({
    NostrWallet: RealNostrWallet,
  }))
})

beforeEach(async () => {
  nwcCalls.length = 0
  nwcBalanceMsat = NWC_BALANCE_SATS * 1000
  getBalanceShouldFail = false
  e2e = await createE2E()
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'en',
  })
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Connect / disconnect / screen copy ---

test('connecting NWC validates the wallet and stores only nwc_url', async () => {
  const before = await snapshot(e2e)

  await e2e.send(privateCallback(staticCallback.connectNwc))
  await expectDelta(e2e, () => e2e.send(privateText(NWC_URL)), {
    db: {
      users: {
        changed: 1,
        match: rows => {
          expect(rows[0]?.after).toMatchObject({id: USER_A, nwcUrl: NWC_URL, nwcTips: false})
        },
      },
      // conversation row is created on connect-nwc and removed when the URL is accepted
      conversations: {removed: 1},
    },
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Wallet connected with NWC/},
      {method: 'sendRichMessage', to: USER_A, text: /<b>ZapGram:<\/b> 0 sats/},
    ],
  })

  const after = await snapshot(e2e)
  expect(after.db.users).toHaveLength(1)
  expect(after.db.users[0]).toMatchObject({nwcUrl: NWC_URL, nwcTips: false})
  expect(after.db.conversations).toEqual([])
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
  expect(after.lnbits.payments).toEqual(before.lnbits.payments)

  const walletText = richHtmlOf(e2e.tg.last('sendRichMessage'))
  expect(walletText).toMatch(/<b>NWC:<\/b> 5\D?000 sats/)
  expect(walletText).not.toMatch(/<b>Balance:<\/b>/)

  expect(nwcCalls.filter(call => call.method === 'getBalance').length).toBeGreaterThanOrEqual(1)
  expectNoErrors(e2e.logs)
})

test('an invalid NWC URL keeps the prompt active and can be corrected', async () => {
  await e2e.send(privateCallback(staticCallback.connectNwc))

  await expectDelta(e2e, () => e2e.send(privateText('https://example.com/wallet')), {
    db: {conversations: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /Invalid NWC URL/}],
  })
  expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)

  await expectDelta(e2e, () => e2e.send(privateText(NWC_URL)), {
    db: {users: {changed: 1}, conversations: {removed: 1}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Wallet connected with NWC/},
      {method: 'sendRichMessage', to: USER_A, text: /<b>ZapGram:<\/b> 0 sats/},
    ],
  })

  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcUrl: NWC_URL})
  expectNoErrors(e2e.logs)
})

test('a failed NWC validation leaves nwc_url null', async () => {
  getBalanceShouldFail = true
  const before = await snapshot(e2e)

  await e2e.send(privateCallback(staticCallback.connectNwc))
  await e2e.send(privateText(NWC_URL))

  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcUrl: null})
  const after = await snapshot(e2e)
  expect(after.db.users).toEqual(before.db.users)
  expect(after.db.conversations).toEqual([])
  expect(after.lnbits).toEqual(before.lnbits)
  expect(e2e.tg.of('sendMessage').some(call => /Wallet connected/.test(String(call.text)))).toBe(
    false,
  )
  expect(errorMessages()).toContain('Bot error')
})

test('disconnecting NWC clears nwc_url and nwc_tips', async () => {
  await connectNwc({nwcTips: true})

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.disconnectNwc)), {
    db: {
      users: {
        changed: 1,
        match: rows => {
          expect(rows[0]?.after).toMatchObject({id: USER_A, nwcUrl: null, nwcTips: false})
        },
      },
    },
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Wallet disconnected/},
      // Same-request wallet must already be the single-balance copy (ctx.nwc cleared).
      {method: 'sendRichMessage', to: USER_A, text: /<b>Balance:<\/b>/},
    ],
  })

  expect(await e2e.container.users.findById(USER_A)).toMatchObject({nwcUrl: null, nwcTips: false})
  const walletText = richHtmlOf(e2e.tg.last('sendRichMessage'))
  expect(walletText).not.toMatch(/NWC:/)
  expectNoErrors(e2e.logs)
})

test('/wallet with a connected NWC shows both balances', async () => {
  await connectNwc()
  creditInternal(USER_A, 1234)

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [{method: 'sendRichMessage', to: USER_A, text: /<b>ZapGram:<\/b> 1\D?234 sats/}],
  })

  const text = richHtmlOf(e2e.tg.last('sendRichMessage'))
  expect(text).toMatch(/<b>NWC:<\/b> 5\D?000 sats/)
  expect(text).not.toMatch(/<b>Balance:<\/b>/)
  expect(nwcCalls.some(call => call.method === 'getBalance')).toBe(true)
  expectNoErrors(e2e.logs)
})

test('the NWC menu with a connected wallet offers disconnect and tips toggle', async () => {
  await connectNwc()

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.settings)), {
    telegram: [{method: 'editMessageText', to: USER_A, text: /Connecting an external wallet/}],
  })

  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual([
    staticCallback.toggleNwcTips,
    staticCallback.disconnectNwc,
    staticCallback.wallet,
  ])
  expectNoErrors(e2e.logs)
})

test('text during wallet selection cancels the action and returns to Wallet', async () => {
  await connectNwc()
  await e2e.send(privateCallback(staticCallback.createInvoice))
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toEqual(['internal', 'nwc', 'cancel'])

  await expectDelta(e2e, () => e2e.send(privateText('internal')), {
    db: {conversations: {removed: 1}},
    telegram: [{method: 'editMessageText', to: USER_A, text: /Wallet/}],
  })

  expectNoErrors(e2e.logs)
})

test('paying an invoice shows decoded details before the wallet picker', async () => {
  await connectNwc()
  creditInternal(USER_A, 2000)
  const invoice = foreignInvoice(100)
  await e2e.send(privateCallback(staticCallback.payInvoice))

  await e2e.send(privateText(invoice.bolt11))

  const prompt = e2e.tg.last('editMessageText')
  expect(String(prompt?.text)).toMatch(/Amount: <b>100 sats/)
  expect(String(prompt?.text)).toMatch(/Select a wallet to pay this invoice/)
  expect(String(prompt?.text)).toContain('<blockquote expandable>')
  expect(String(prompt?.text)).not.toMatch(/Powered by t\.me\/zap_gram_bot/)
  expect(String(prompt?.text)).not.toMatch(/Description:/)
  expect(prompt?.link_preview_options).toEqual({is_disabled: true})
  expect(callbackDataOf(prompt)).toEqual(['internal', 'nwc', 'cancel'])
  expect(buttonTextsOf(prompt)).toEqual(expect.arrayContaining(['🤖 ZapGram', '⚡️ NWC']))
  expectNoErrors(e2e.logs)
})

test('paying an invoice does not offer a wallet that cannot cover it', async () => {
  await connectNwc()
  const invoice = foreignInvoice(100)
  await e2e.send(privateCallback(staticCallback.payInvoice))

  await e2e.send(privateText(invoice.bolt11))

  const prompt = e2e.tg.last('editMessageText')
  expect(callbackDataOf(prompt)).toEqual(['nwc', 'cancel'])
  expect(buttonTextsOf(prompt)).toContain('⚡️ NWC')
  expect(buttonTextsOf(prompt).join('\n')).not.toMatch(/ZapGram/)
  expectNoErrors(e2e.logs)
})

test('paying an invoice hides NWC and notes it when the balance cannot be read', async () => {
  getBalanceShouldFail = true
  await connectNwc()
  creditInternal(USER_A, 2000)
  const invoice = foreignInvoice(100)
  await e2e.send(privateCallback(staticCallback.payInvoice))

  await e2e.send(privateText(invoice.bolt11))

  const prompt = e2e.tg.last('editMessageText')
  expect(String(prompt?.text)).toMatch(/Couldn't reach the connected NWC wallet/)
  expect(callbackDataOf(prompt)).toEqual(['internal', 'cancel'])
  expect(buttonTextsOf(prompt)).toContain('🤖 ZapGram')
  expect(buttonTextsOf(prompt).join('\n')).not.toMatch(/NWC/)
  expectNoErrors(e2e.logs)
})

test('wallet selection consumes Cancel from its own prompt', async () => {
  await connectNwc()
  await e2e.send(privateCallback(staticCallback.createInvoice))

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(staticCallback.cancel, {messageId: requiredPromptMessageId()})),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'editMessageText', to: USER_A, text: /Wallet/},
      ],
    },
  )
  expectNoErrors(e2e.logs)
})

// --- Tips via NWC ---

test('a group tip with nwc_tips pays through NWC and leaves the sender LNbits balance alone', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  await connectNwc({nwcTips: true})
  creditInternal(USER_A, 1000)
  const senderBefore = internalBalanceMsat(USER_A)
  const recipientBefore = internalBalanceMsat(USER_B)
  const payCallsBefore = nwcCalls.filter(call => call.method === 'payInvoice').length

  await expectDelta(
    e2e,
    () => e2e.send(groupText('/tip 21 @user_b', {from: {id: USER_A, username: 'user_a'}})),
    {
      lnbits: {
        balances: {'100002 wallet': TIP_SATS},
        payments: [{out: false, sats: TIP_SATS, times: 1}],
      },
      telegram: [
        {method: 'deleteMessage', to: CHAT_GROUP},
        {method: 'sendChatAction', to: CHAT_GROUP},
        {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
        {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
      ],
    },
  )

  expect(internalBalanceMsat(USER_A)).toBe(senderBefore)
  expect(internalBalanceMsat(USER_B)).toBe(recipientBefore + TIP_SATS * 1000)
  // External NWC money — no outgoing payment on any LNbits wallet.
  expect(e2e.ln.state.payments.filter(payment => payment.out)).toHaveLength(0)
  expect(nwcCalls.filter(call => call.method === 'payInvoice')).toHaveLength(payCallsBefore + 1)
  const payCall = [...nwcCalls].reverse().find(call => call.method === 'payInvoice')
  const paidInvoice = String(payCall?.args[0] ?? '')
  expect(paidInvoice.startsWith('lnbc')).toBe(true)
  expectNoErrors(e2e.logs)
})

// --- Subscriptions via NWC ---

test('a join chooser offers the balance button when the NWC balance covers the price', async () => {
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await connectNwc()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    type: 'supergroup',
    status: 'active',
    paymentType: 'one_time',
    price: PRICE,
  })

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        chatJoinRequest('supergroup', {
          from: {id: USER_A, username: 'user_a', language_code: 'en'},
        }),
      ),
    {
      telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
    },
  )

  const callbacks = callbackDataOf(e2e.tg.last('sendMessage'))
  expect(callbacks).toContain(`pay-join-balance:${CHAT_GROUP}:nwc`)
  expect(callbacks.some(data => data.startsWith('pay-lightning:'))).toBe(true)
  expect(callbacks.some(data => data.endsWith(':wallet'))).toBe(false)
  expect(nwcCalls.some(call => call.method === 'getBalance')).toBe(true)
  expectNoErrors(e2e.logs)
})

test('paying a join via NWC balance settles the master invoice without debiting the user', async () => {
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await connectNwc()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    type: 'supergroup',
    status: 'active',
    paymentType: 'one_time',
    price: PRICE,
  })

  await e2e.send(
    chatJoinRequest('supergroup', {
      from: {id: USER_A, username: 'user_a', language_code: 'en'},
    }),
  )
  const balancePayData = callbackDataOf(e2e.tg.last('sendMessage')).find(
    data => data === `pay-join-balance:${CHAT_GROUP}:nwc`,
  )
  if (!balancePayData) throw new Error('Expected a pay-join-balance NWC button')

  const userBefore = internalBalanceMsat(USER_A)
  const masterBefore = masterBalanceMsat()
  nwcCalls.length = 0

  await expectDelta(e2e, () => e2e.send(privateCallback(balancePayData)), {
    db: {
      subscriptionIntents: {added: 1},
      subscriptionPayments: {added: 1},
    },
    lnbits: {
      balances: {'master wallet': PRICE},
      // Unpaid master invoice flips to paid — external money, no outgoing LNbits leg.
      payments: [{out: false, sats: PRICE, times: 1}],
    },
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'answerCallbackQuery'},
      {method: 'sendMessage', to: USER_A, text: /Payment completed/},
    ],
  })

  expect(internalBalanceMsat(USER_A)).toBe(userBefore)
  expect(masterBalanceMsat()).toBe(masterBefore + PRICE * 1000)
  expect(nwcCalls.some(call => call.method === 'payInvoice')).toBe(true)
  const payments = await e2e.db.select().from(subscriptionPaymentsTable)
  expect(payments).toHaveLength(1)
  expect(payments[0]?.settledAt).toBeNull() // settle job is a separate tick
  expect(
    e2e.ln.state.payments.some(
      payment => !payment.out && payment.paid && payment.amountMsat === PRICE * 1000,
    ),
  ).toBe(true)
  expectNoErrors(e2e.logs)
})

test('an insufficient NWC balance does not offer the NWC pay button', async () => {
  nwcBalanceMsat = (PRICE - 1) * 1000
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await connectNwc()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    type: 'supergroup',
    status: 'active',
    paymentType: 'one_time',
    price: PRICE,
  })

  await e2e.send(
    chatJoinRequest('supergroup', {
      from: {id: USER_A, username: 'user_a', language_code: 'en'},
    }),
  )

  const callbacks = callbackDataOf(e2e.tg.last('sendMessage'))
  expect(callbacks.some(data => data.endsWith(':nwc'))).toBe(false)
  expect(callbacks.some(data => data.startsWith('pay-lightning:'))).toBe(true)
  expectNoErrors(e2e.logs)
})

// --- Auto-renew via NWC ---

const RENEWAL_FEE = 50 // SUBSCRIPTION_FEE_PERCENT default 5% of PRICE
const RENEWAL_OWNER_PAYOUT = PRICE - RENEWAL_FEE

test('an expiring subscription auto-renews via NWC when the internal balance is empty', async () => {
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await connectNwc()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    type: 'supergroup',
    status: 'active',
    paymentType: 'monthly',
    price: PRICE,
  })
  const subscription = await seedExpiringSubscription(e2e, {price: PRICE, autoRenew: true})
  // Internal balance stays empty — auto-renew must fall back to NWC.
  const userBefore = internalBalanceMsat(USER_A)
  const ownerWallet = walletByUsername(OWNER)
  const feeWallet = walletByName('fees wallet')
  nwcCalls.length = 0

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => {
          expect(rows).toHaveLength(1)
          const row = rows[0]
          if (!row?.after || !(row.after instanceof Object)) {
            throw new Error('Expected subscription after-row')
          }
          if (!subscription.endsAt) throw new Error('Expiring seed must have endsAt')
          const beforeEndsAt = subscription.endsAt
          expect(row.before).toMatchObject({id: subscription.id, endsAt: beforeEndsAt})
          expect(row.after).toMatchObject({
            id: subscription.id,
            price: PRICE,
            autoRenew: true,
            notificationSent: false,
          })
          const afterEndsAt = (row.after as {endsAt: Date}).endsAt
          expect(afterEndsAt.getTime()).toBeGreaterThan(beforeEndsAt.getTime())
        },
      },
    },
    lnbits: {
      // NWC credits master externally (no user LNbits debit); settle pays owner + fee.
      balances: {
        [ownerWallet.name]: RENEWAL_OWNER_PAYOUT,
        [feeWallet.name]: RENEWAL_FEE,
      },
      payments: [
        {out: false, sats: PRICE, times: 1},
        {out: false, sats: RENEWAL_OWNER_PAYOUT, times: 1},
        {out: true, sats: RENEWAL_OWNER_PAYOUT, times: 1},
        {out: false, sats: RENEWAL_FEE, times: 1},
        {out: true, sats: RENEWAL_FEE, times: 1},
      ],
    },
    telegram: [
      {method: 'approveChatJoinRequest', to: CHAT_GROUP},
      {method: 'sendMessage', to: USER_A, text: /has been extended|продлена/i},
      {method: 'sendMessage', to: OWNER, text: /New subscription payment/},
    ],
  })

  expect(internalBalanceMsat(USER_A)).toBe(userBefore)
  expect(nwcCalls.some(call => call.method === 'payInvoice')).toBe(true)
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([])
  // Balance pay fails (empty wallet) before NWC succeeds — those errors are expected.
  expect(errorMessages().some(msg => msg.includes('Error paying invoice from balance'))).toBe(true)
})

// --- helpers ---

function richHtmlOf(payload: Record<string, unknown> | undefined): string {
  const richMessage = payload?.rich_message
  if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
  return String(Reflect.get(richMessage, 'html') ?? '')
}

/**
 * Credit an LNbits wallet as if an external NWC payment just settled its unpaid invoice.
 * Money enters the fake ledger from outside — the same shape a real NWC pay produces.
 */
function settleIncomingInvoice(bolt11: string): void {
  const payment = e2e.ln.state.payments.find(
    candidate => candidate.bolt11 === bolt11 && !candidate.out,
  )
  if (!payment) {
    throw new Error(`Fake NWC payInvoice: no LNbits invoice for ${bolt11.slice(0, 24)}…`)
  }
  if (payment.paid) return
  const wallet = e2e.ln.state.wallets.find(candidate => candidate.id === payment.walletId)
  if (!wallet) throw new Error(`Fake NWC payInvoice: wallet ${payment.walletId} missing`)
  payment.paid = true
  wallet.balanceMsat += payment.amountMsat
}

async function connectNwc(opts: {nwcTips?: boolean} = {}): Promise<void> {
  await e2e.container.users.update(USER_A, {
    nwcUrl: NWC_URL,
    nwcTips: opts.nwcTips ?? false,
  })
}

function creditInternal(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function internalBalanceMsat(userId: number): number {
  const lnUser = e2e.ln.state.getUserByUsername(String(userId))
  const wallet = lnUser ? e2e.ln.state.walletsOfUser(lnUser.id)[0] : undefined
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet.balanceMsat
}

function masterBalanceMsat(): number {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake LNbits master wallet not found')
  return master.balanceMsat
}

function walletByUsername(userId: number) {
  const lnUser = e2e.ln.state.getUserByUsername(String(userId))
  const wallet = lnUser ? e2e.ln.state.walletsOfUser(lnUser.id)[0] : undefined
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet
}

function walletByName(name: string) {
  const wallet = e2e.ln.state.wallets.find(candidate => candidate.name === name)
  if (!wallet) throw new Error(`Fake LNbits wallet not found: ${name}`)
  return wallet
}

function foreignInvoice(sats: number) {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake LNbits master wallet not found')
  return e2e.ln.state.createInvoice({
    wallet: master,
    sats,
    memo: e2e.container.config.memoFooter,
    expirySec: 3600,
  })
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function buttonTextsOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {text?: string}[][]}
  return (markup?.inline_keyboard ?? [])
    .flat()
    .flatMap(button => (typeof button.text === 'string' ? [button.text] : []))
}

function requiredPromptMessageId(): number {
  const edited = e2e.tg.lastMessageId('editMessageText')
  if (edited !== undefined) return edited
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound prompt message ID')
  return messageId
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
