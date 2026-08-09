import {afterEach, beforeEach, expect, test} from 'bun:test'
import {conversationsTable, pendingInvoicesTable} from '@infra/db/schema.js'
import {changingPrice} from '@modules/chats/telegram/conversations/changing-price.js'
import {editCustomMessage} from '@modules/chats/telegram/conversations/edit-custom-message.js'
import {creatingInvoice} from '@modules/invoices/telegram/conversations/creating-invoice.js'
import {payingInvoice} from '@modules/invoices/telegram/conversations/paying-invoice.js'
import {sendingToUser} from '@modules/tipping/telegram/sending-to-user.js'
import {connectingNWC} from '@modules/wallet/telegram/conversations/connecting-nwc.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {Update} from 'grammy/types'
import {expectNoConversations, expectNoErrors} from '../asserts.js'
import {decodeMintedInvoice, mintInvoice} from '../fakes/bolt11.js'
import {CHAT_GROUP, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedPendingInvoice, seedUser} from '../fixtures/seed.js'
import {privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.invoices

/**
 * Lightning invoices and the six conversations that surround them.
 *
 * A conversation is the only place in the bot where one user action spans several updates, so the
 * questions worth asking are about the seams: what the world looks like between two steps, what a
 * cancel leaves behind, and which halts let the update fall through to the handler below.
 *
 * Two behaviours are asserted throughout and are easy to misread as noise:
 *
 * - the wallet screen after a cancel is *not* sent by the conversation. Each step halts with
 *   `{next: true}`, so the same update goes on to the terminal `cancel` handler (or, for a text
 *   message, to the `on('message')` wallet fallback). Steps that halt without `next` — an amount
 *   out of range, an over-long memo — therefore end with no wallet screen at all, and that
 *   difference is what those cases pin.
 * - a conversation writes exactly one `conversations` row, keyed by chat. It appears when the
 *   conversation is entered and is gone the moment it ends, however it ends.
 *
 * NWC is never connected here, so `waitForWallet` resolves to the internal wallet without asking.
 */

const AMOUNT = 1000
const MEMO = 'coffee'
/** Appended to every invoice memo by `buildInvoiceMemo`, built from `BOT_USERNAME`. */
const MEMO_FOOTER = 'Powered by t.me/zap_gram_bot'
const PENDING_SATS = 21
const FOREIGN_SATS = 100
/** LNbits reserves max(2000 msat, 1%) on a foreign invoice; 100 sats hits the floor. */
const FOREIGN_FEE_SATS = 2

let e2e: E2E

beforeEach(async () => {
  // BOT_USERNAME only matters for the memo footer, and a footer reading "t.me/undefined" would
  // make the "footer is stripped from the caption" assertion prove nothing.
  e2e = await createE2E({env: {BOT_USERNAME: 'zap_gram_bot'}})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Creating an invoice ---

test('the create-invoice button opens a conversation asking for an amount', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.createInvoice)), {
    db: {conversations: {added: 1}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Creating Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Enter the amount of sats/},
    ],
  })

  expect(keyboardOf(e2e.tg.last('sendMessage'))).toEqual(['cancel'])
  expectNoErrors(e2e.logs)
})

test('the amount step mints an invoice without a memo and offers Add memo', async () => {
  await e2e.send(privateCallback(staticCallback.createInvoice))

  await expectDelta(e2e, () => e2e.send(privateText(String(AMOUNT))), {
    db: {conversations: {changed: 1}, pendingInvoices: {added: 1}},
    lnbits: {payments: [{out: false, sats: AMOUNT, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendPhoto', to: USER_A, text: /Amount: <b>1\D?000 sats(?: \(~\$[^)]+\))?<\/b>/},
    ],
  })

  expect(keyboardOf(e2e.tg.last('sendPhoto'))).toEqual([
    staticCallback.addInvoiceMemo,
    staticCallback.cancel,
  ])
  expect(lastInvoiceMemo()).toBe(MEMO_FOOTER)
  expect(String(e2e.tg.last('sendPhoto')?.caption)).not.toContain('Description:')
  expectNoErrors(e2e.logs)
})

test('a finished invoice is one pending row, one LNbits invoice and one QR photo', async () => {
  await enterCreateInvoiceAtQr()

  const row = await onlyPendingInvoice()
  const decoded = decodeMintedInvoice(row.paymentRequest)
  expect(row.userId).toBe(USER_A)
  expect(decoded?.paymentHash).toBe(row.paymentHash)
  expect(decoded?.amountMsat).toBe(AMOUNT * 1000)
  // The default expiry is a day, and it is LNbits that decides it: the row stores what came back.
  expect(hoursFromNow(row.expiresAt)).toBeGreaterThan(23)
  expect(hoursFromNow(row.expiresAt)).toBeLessThan(25)
  // Instant notify path: createInvoice must register an LNbits webhook for this host.
  const createBody = e2e.ln.requests.find(
    r => r.method === 'POST' && r.path === '/api/v1/payments' && bodyOutFalse(r.body),
  )?.body as Record<string, unknown> | undefined
  expect(createBody?.webhook).toBe(
    `https://test.local/lnbits/webhook/${e2e.container.config.BOT_WEBHOOK_SECRET}`,
  )
  expectNoErrors(e2e.logs)
})

test('adding a memo remints the invoice and edits the QR without the Add memo button', async () => {
  await enterCreateInvoiceAtQr()
  const previous = await onlyPendingInvoice()

  await e2e.send(privateCallback(staticCallback.addInvoiceMemo))

  await expectDelta(e2e, () => e2e.send(privateText(MEMO)), {
    db: {
      conversations: {removed: 1},
      // Old no-memo invoice stays tracked: its BOLT11 can still be paid.
      pendingInvoices: {added: 1},
    },
    lnbits: {payments: [{out: false, sats: AMOUNT, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'editMessageMedia', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  const rows = await e2e.db.select().from(pendingInvoicesTable)
  expect(rows).toHaveLength(2)
  expect(rows.some(row => row.paymentRequest === previous.paymentRequest)).toBe(true)
  expect(rows.some(row => row.paymentRequest !== previous.paymentRequest)).toBe(true)

  expect(lastInvoiceMemo()).toBe(`${MEMO}\n\n${MEMO_FOOTER}`)
  const mediaPayload = e2e.tg.last('editMessageMedia')
  const media = mediaPayload?.media as {caption?: string} | undefined
  expect(media?.caption).toContain(`Description: <b>${MEMO}</b>`)
  expect(media?.caption).not.toContain(MEMO_FOOTER)
  expect(media?.caption).not.toContain(previous.paymentRequest)
  expect(mediaPayload?.reply_markup).toBeUndefined()
  expectNoErrors(e2e.logs)
})

test('an LNbits that refuses to mint the invoice leaves no pending row behind', async () => {
  await e2e.send(privateCallback(staticCallback.createInvoice))
  e2e.ln.state.failAlways({method: 'POST', path: '/api/v1/payments'}, {status: 500, body: {}})

  await expectDelta(e2e, () => e2e.send(privateText(String(AMOUNT))), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Failed to create the Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  // Mint is attempted once (`got` does not retry POST); domain mapping adds a third log line.
  expect(errorMessages()).toEqual([
    'POST /api/v1/payments: HTTP error',
    'Error creating invoice',
    'Bot error',
  ])
})

// --- Paying an invoice ---

test('a message containing a bolt11 opens the review with a pay button', async () => {
  // Minted before the window: issuing it is an LNbits event, and the point here is what the
  // *message* does. Balance is checked before review so the payer must be able to cover amount.
  credit(USER_A, 1000)
  const invoice = foreignInvoice()

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    db: {conversations: {added: 1}},
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /Paying Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Invoice review/},
    ],
  })

  // The pay button carries a timestamp so a button from an earlier review cannot pay this one.
  const buttons = keyboardOf(e2e.tg.last('sendMessage'))
  expect(buttons[0]).toMatch(/^pay:\d+$/)
  expect(buttons[1]).toBe('cancel')
  expectNoErrors(e2e.logs)
})

test('an invoice the bot issued itself is reviewed with no fee and no fee-reserve lookup', async () => {
  const pending = await seedRecipientInvoice()
  credit(USER_A, 1000)
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(pending.paymentRequest))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Fee: <b>0 sats(?: \(~\$[^)]+\))?<\/b>/)
  expect(lnPathsSince(mark)).not.toContain('GET /api/v1/payments/fee-reserve')
  expectNoErrors(e2e.logs)
})

test('a foreign invoice is reviewed with the fee reserve LNbits quotes for it', async () => {
  credit(USER_A, 1000)
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(foreignInvoice().bolt11))

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(
    new RegExp(`Fee: <b>${FOREIGN_FEE_SATS} sats(?: \\(~\\$[^)]+\\))?</b>`),
  )
  expect(lnPathsSince(mark)).toContain('GET /api/v1/payments/fee-reserve')
  expectNoErrors(e2e.logs)
})

test('paying a pending invoice moves the sats, drops the row and notifies the payee', async () => {
  const pending = await seedRecipientInvoice()
  credit(USER_A, 1000)
  await e2e.send(privateText(pending.paymentRequest))
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(privateCallback(payButton())), {
    db: {pendingInvoices: {removed: 1}, conversations: {removed: 1}},
    lnbits: {
      balances: {'100001 wallet': -PENDING_SATS, '100002 wallet': PENDING_SATS},
      payments: [
        {out: false, sats: PENDING_SATS, times: 1},
        {out: true, sats: PENDING_SATS, times: 1},
      ],
    },
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_B, text: /You received payment for a Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Invoice paid/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  // An internal transfer costs nothing, so the payer is debited the invoice amount and no more.
  const receipt = String(e2e.tg.of('sendMessage').at(-2)?.text)
  expect(receipt).toMatch(
    new RegExp(`Payment amount: <b>${PENDING_SATS} sats(?: \\(~\\$[^)]+\\))?</b>`),
  )
  expect(receipt).toMatch(/Fee: <b>0 sats(?: \(~\$[^)]+\))?<\/b>/)
  expect(receipt).toMatch(new RegExp(`Total: <b>${PENDING_SATS} sats(?: \\(~\\$[^)]+\\))?</b>`))
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('an expired invoice is reviewed without a pay button and ends the conversation', async () => {
  credit(USER_A, 1000)
  const expired = mintInvoice({
    sats: FOREIGN_SATS,
    description: 'stale',
    expirySec: 60,
    timestampSec: Math.floor(Date.now() / 1000) - 3600,
  })

  await expectDelta(e2e, () => e2e.send(privateText(expired.bolt11)), {
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /Paying Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Invoice expired/},
    ],
  })

  expect(e2e.tg.last('sendMessage')?.reply_markup).toBeUndefined()
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('insufficient balance refuses payment before the review step', async () => {
  const invoice = foreignInvoice()

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /Paying Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Insufficient funds/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  await expectNoConversations(e2e.db)
  expect(errorMessages()).toEqual(['Bot error'])
})

test('a 520 for an already paid invoice leaves the pending row alone', async () => {
  const pending = await seedRecipientInvoice()
  credit(USER_A, 1000)
  e2e.ln.state.payInvoice({payerWallet: walletOf(USER_A), bolt11: pending.paymentRequest})
  await e2e.send(privateText(pending.paymentRequest))

  await expectDelta(e2e, () => e2e.send(privateCallback(payButton())), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /already been paid/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })

  // The row is the payee's claim on a payment that already happened; a failed second attempt at it
  // must not delete it. The pending-invoices job is what eventually clears it.
  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
  expect(errorMessages()).toEqual([
    'POST /api/v1/payments: HTTP error',
    'Error paying invoice',
    'Bot error',
  ])
})

test('a pay button from an earlier review cancels instead of paying', async () => {
  credit(USER_A, 1000)
  await e2e.send(privateText(foreignInvoice().bolt11))

  await expectDelta(e2e, () => e2e.send(privateCallback('pay:1')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'deleteMessage', to: USER_A},
      {method: 'answerCallbackQuery', text: /Unknown button/},
    ],
  })

  expectNoErrors(e2e.logs)
})

// --- Cancel, at every step of every conversation ---

const cancelCases: {conversation: string; step: string; reach: () => Promise<void>}[] = [
  {conversation: creatingInvoice.name, step: 'amount', reach: enterCreateInvoiceAtAmount},
  {conversation: creatingInvoice.name, step: 'qr', reach: enterCreateInvoiceAtQr},
  {conversation: creatingInvoice.name, step: 'memo', reach: enterCreateInvoiceAtMemo},
  {conversation: payingInvoice.name, step: 'invoice', reach: enterPayInvoiceAtInvoice},
  {conversation: payingInvoice.name, step: 'review', reach: enterPayInvoiceAtReview},
  {conversation: connectingNWC.name, step: 'url', reach: enterConnectNwcAtUrl},
  {conversation: sendingToUser.name, step: 'username', reach: enterSendToUserAtUsername},
  {conversation: sendingToUser.name, step: 'amount', reach: enterSendToUserAtAmount},
  {conversation: changingPrice.name, step: 'price', reach: enterChangePriceAtPrice},
  {conversation: editCustomMessage.name, step: 'russian', reach: enterCustomMessageAtRussian},
  {conversation: editCustomMessage.name, step: 'english', reach: enterCustomMessageAtEnglish},
]

for (const {conversation, step, reach} of cancelCases) {
  test(`cancel at the ${step} step of ${conversation} leaves nothing behind`, async () => {
    await reach()

    await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageReplyMarkup', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Action canceled/},
        {method: 'sendMessage', to: USER_A, text: /Balance:/},
      ],
    })

    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('the cancel cases cover every conversation the bot registers', () => {
  const covered = [...new Set(cancelCases.map(item => item.conversation))].sort()
  expect(covered).toEqual(
    [
      changingPrice.name,
      connectingNWC.name,
      creatingInvoice.name,
      editCustomMessage.name,
      payingInvoice.name,
      sendingToUser.name,
    ].sort(),
  )
})

// --- Input a step cannot use ---

const invalidCases: {
  label: string
  reach: () => Promise<void>
  input: () => Update
  replies: RegExp[]
}[] = [
  {
    label: 'a word where an amount belongs',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('abc'),
    replies: [/Invalid amount of sats/, /Action canceled/, /Balance:/],
  },
  {
    label: 'an amount of zero',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('0'),
    replies: [/Invalid amount of sats/, /Action canceled/],
  },
  {
    label: 'a negative amount',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('-5'),
    replies: [/Invalid amount of sats/, /Action canceled/],
  },
  {
    label: 'an amount above the maximum',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('100000001'),
    replies: [/Invalid amount of sats/, /Action canceled/],
  },
  {
    label: 'a memo longer than 150 characters',
    reach: enterCreateInvoiceAtMemo,
    input: () => privateText('m'.repeat(151)),
    // Invalid memo keeps the no-memo invoice and ends with the wallet screen (no Action canceled).
    replies: [/Invalid memo/, /Balance:/],
  },
  {
    label: 'a message with no invoice in it',
    reach: enterPayInvoiceAtInvoice,
    input: () => privateText('pay me back sometime'),
    replies: [/Invalid Lightning invoice/, /Action canceled/, /Balance:/],
  },
  {
    label: 'a username without its @',
    reach: enterSendToUserAtUsername,
    input: () => privateText('user_b'),
    replies: [/Invalid username/, /Action canceled/, /Balance:/],
  },
  {
    label: 'a link that is not an NWC URL',
    reach: enterConnectNwcAtUrl,
    input: () => privateText('https://example.com/wallet'),
    replies: [/Invalid NWC URL/, /Action canceled/, /Balance:/],
  },
  {
    label: 'a photo where a custom message belongs',
    reach: enterCustomMessageAtRussian,
    input: privatePhoto,
    replies: [/valid text message/, /Action canceled/],
  },
]

for (const {label, reach, input, replies} of invalidCases) {
  test(`${label} ends the conversation without touching anything`, async () => {
    await reach()

    await expectDelta(e2e, () => e2e.send(input()), {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageReplyMarkup', to: USER_A},
        ...replies.map(text => ({method: 'sendMessage', to: USER_A, text})),
      ],
    })

    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

// --- Living alongside the rest of the bot ---

// docs/known-issues.md — every conversation is installed above every command, so /wallet
// always cancels the active conversation (uniform rule; no registration-order asymmetry).
test('/wallet cancels creatingInvoice waiting for an amount', async () => {
  await enterCreateInvoiceAtAmount()

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('/wallet cancels connectingNWC waiting for a URL', async () => {
  await enterConnectNwcAtUrl()

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invalid NWC URL/},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Balance:/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('starting another conversation cancels the one in progress', async () => {
  await enterCreateInvoiceAtAmount()

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.payInvoice)), {
    db: {conversations: {changed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Paying Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Send or forward a message/},
    ],
  })

  expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('cancel outside a conversation just re-renders the wallet', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Balance:/}],
  })

  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

// --- Reaching a step ---

async function enterCreateInvoiceAtAmount(): Promise<void> {
  await e2e.send(privateCallback(staticCallback.createInvoice))
}

async function enterCreateInvoiceAtQr(): Promise<void> {
  await enterCreateInvoiceAtAmount()
  await e2e.send(privateText(String(AMOUNT)))
}

async function enterCreateInvoiceAtMemo(): Promise<void> {
  await enterCreateInvoiceAtQr()
  await e2e.send(privateCallback(staticCallback.addInvoiceMemo))
}

async function enterPayInvoiceAtInvoice(): Promise<void> {
  await e2e.send(privateCallback(staticCallback.payInvoice))
}

async function enterPayInvoiceAtReview(): Promise<void> {
  credit(USER_A, 1000)
  await e2e.send(privateText(foreignInvoice().bolt11))
}

async function enterConnectNwcAtUrl(): Promise<void> {
  await e2e.send(privateCallback(staticCallback.connectNwc))
}

async function enterSendToUserAtUsername(): Promise<void> {
  await e2e.send(privateCallback(staticCallback.sendToUser))
}

async function enterSendToUserAtAmount(): Promise<void> {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  // `waitForUser` cross-checks the stored username against Telegram before accepting it, and the
  // fake's default getChat answers with a username of its own.
  e2e.tg.reply('getChat', {id: USER_B, type: 'private', username: 'user_b', first_name: 'User B'})
  await enterSendToUserAtUsername()
  await e2e.send(privateText('@user_b'))
}

async function enterChangePriceAtPrice(): Promise<void> {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})
  await e2e.send(privateCallback(`chat:${CHAT_GROUP}:change-price`))
}

async function enterCustomMessageAtRussian(): Promise<void> {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})
  await e2e.send(privateCallback(`chat:${CHAT_GROUP}:edit-custom-message`))
}

async function enterCustomMessageAtEnglish(): Promise<void> {
  await enterCustomMessageAtRussian()
  await e2e.send(privateText('Привет'))
}

// --- Reading the world ---

function foreignInvoice() {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake LNbits master wallet not found')
  return e2e.ln.state.createInvoice({
    wallet: master,
    sats: FOREIGN_SATS,
    memo: 'issued elsewhere',
    expirySec: 3600,
  })
}

/** An invoice USER_B is waiting to be paid, so paying it exercises the pending-invoice branch. */
async function seedRecipientInvoice() {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  return seedPendingInvoice(e2e, {userId: USER_B, sats: PENDING_SATS})
}

function walletOf(userId: number) {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet
}

function credit(userId: number, sats: number): void {
  e2e.ln.state.credit(walletOf(userId).id, sats * 1000)
}

/** The review keyboard's pay button, whose data carries a timestamp and cannot be constructed. */
function payButton(): string {
  const data = keyboardOf(e2e.tg.last('sendMessage'))[0]
  if (!data?.startsWith('pay:')) throw new Error(`Expected a pay button, got ${String(data)}`)
  return data
}

function keyboardOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function lnPathsSince(mark: number): string[] {
  return e2e.ln.requests.slice(mark).map(request => `${request.method} ${request.path}`)
}

function lastInvoiceMemo(): string | undefined {
  return e2e.ln.state.payments.at(-1)?.memo
}

async function onlyPendingInvoice() {
  const rows = await e2e.db.select().from(pendingInvoicesTable)
  const row = rows[0]
  if (rows.length !== 1 || !row) throw new Error(`Expected one pending invoice, got ${rows.length}`)
  return row
}

function hoursFromNow(date: Date | null): number {
  if (!date) throw new Error('Expected an expiry date')
  return (date.getTime() - Date.now()) / (60 * 60 * 1000)
}

function bodyOutFalse(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && Reflect.get(body, 'out') === false)
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

/** A private message with no text at all, which every text step has to refuse. */
function privatePhoto(): Update {
  const update = privateText('')
  const message = update.message
  if (!message) throw new Error('privatePhoto did not create a message')
  Reflect.deleteProperty(message, 'text')
  Object.assign(message, {
    photo: [
      {file_id: 'photo-large', file_unique_id: 'photo-large-unique', width: 320, height: 320},
    ],
  })
  return update
}
