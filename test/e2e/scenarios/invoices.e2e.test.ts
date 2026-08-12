import {afterEach, beforeEach, expect, test} from 'bun:test'
import {conversationsTable, pendingInvoicesTable} from '@infra/db/schema.js'
import {changingPrice} from '@modules/chats/telegram/conversations/changing-price.js'
import {editCustomMessage} from '@modules/chats/telegram/conversations/edit-custom-message.js'
import {creatingInvoice} from '@modules/invoices/telegram/conversations/creating-invoice.js'
import {payingInvoice} from '@modules/invoices/telegram/conversations/paying-invoice.js'
import {sendingToUser} from '@modules/tipping/telegram/sending-to-user.js'
import {connectingNWC} from '@modules/wallet/telegram/conversations/connecting-nwc.js'
import {
  chatCustomMessageEditRoute,
  donationPercentRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {registeredConversations} from '@telegram/composition.js'
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
 * - migrated text prompts distinguish their own Cancel button by message ID. It edits that prompt
 *   and consumes the callback; a command or callback from another message edits the prompt and
 *   falls through to its normal handler. Callback-only invoice steps are migrated separately.
 * - a conversation writes exactly one `conversations` row, keyed by chat. It appears when the
 *   conversation is entered and is gone the moment it ends, however it ends.
 *
 * NWC is never connected here, so paying an invoice offers only the internal wallet button.
 */

const AMOUNT = 1000
const MEMO = 'coffee'
/** Appended to every invoice memo by `buildInvoiceMemo`, built from `BOT_USERNAME`. */
const MEMO_FOOTER = 'Powered by t.me/zap_gram_bot'
const PENDING_SATS = 21
const FOREIGN_SATS = 100

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
    telegram: [{method: 'editMessageText', to: USER_A, text: /Creating Lightning invoice/}],
  })

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Enter the amount of sats/)
  expect(keyboardOf(e2e.tg.last('editMessageText'))).toEqual(['cancel'])
  expectNoErrors(e2e.logs)
})

test('the amount step mints an invoice without a memo and offers Add memo', async () => {
  await e2e.send(privateCallback(staticCallback.createInvoice))

  await expectDelta(e2e, () => e2e.send(privateText(String(AMOUNT))), {
    db: {conversations: {changed: 1}, pendingInvoices: {added: 1}},
    lnbits: {payments: [{out: false, sats: AMOUNT, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {
        method: 'editMessageMedia',
        to: USER_A,
        text: /Amount: <b>1\D?000 sats(?: \(\$[^)]+\))?<\/b>/,
      },
    ],
  })

  expect(keyboardOf(e2e.tg.last('editMessageMedia'))).toEqual([
    staticCallback.addInvoiceMemo,
    staticCallback.wallet,
  ])
  expect(lastInvoiceMemo()).toBe(MEMO_FOOTER)
  expect(lastInvoiceCaption()).toContain('Wallet: <b>ZapGram</b>')
  expect(lastInvoiceCaption()).toContain('<blockquote expandable>')
  expect(lastInvoiceCaption()).not.toContain('Description:')
  expectNoErrors(e2e.logs)
})

test('wallet on the QR step sends a new wallet and drops the invoice keyboard', async () => {
  await enterCreateInvoiceAtQr()
  const qrMessageId = requiredInvoiceHostMessageId()

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(staticCallback.wallet, {
          messageId: qrMessageId,
        }),
      ),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'editMessageReplyMarkup', to: USER_A},
        {method: 'sendRichMessage', to: USER_A, text: /Wallet/},
      ],
    },
  )

  expect(e2e.tg.last('editMessageReplyMarkup')).toMatchObject({
    message_id: qrMessageId,
    reply_markup: {inline_keyboard: []},
  })
  expect(e2e.tg.of('editMessageCaption')).toHaveLength(0)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
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

  await openMemoPrompt()

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
      {method: 'editMessageMedia', to: USER_A, text: /Description: <b>coffee<\/b>/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })

  const rows = await e2e.db.select().from(pendingInvoicesTable)
  expect(rows).toHaveLength(2)
  expect(rows.some(row => row.paymentRequest === previous.paymentRequest)).toBe(true)
  expect(rows.some(row => row.paymentRequest !== previous.paymentRequest)).toBe(true)

  expect(lastInvoiceMemo()).toBe(`${MEMO}\n\n${MEMO_FOOTER}`)
  expect(lastInvoiceCaption()).toContain(`Description: <b>${MEMO}</b>`)
  expect(lastInvoiceCaption()).not.toContain(MEMO_FOOTER)
  expect(lastInvoiceCaption()).not.toContain(previous.paymentRequest)
  expect(keyboardOf(e2e.tg.last('editMessageMedia'))).toEqual([staticCallback.wallet])
  expectNoErrors(e2e.logs)
})

test('an LNbits that refuses to mint the invoice leaves no pending row behind', async () => {
  await e2e.send(privateCallback(staticCallback.createInvoice))
  e2e.ln.state.failAlways({method: 'POST', path: '/api/v1/payments'}, {status: 500, body: {}})

  await expectDelta(e2e, () => e2e.send(privateText(String(AMOUNT))), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Failed to create the Lightning invoice/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
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

test('a message containing a bolt11 opens invoice details and the wallet picker', async () => {
  // Minted before the window: issuing it is an LNbits event, and the point here is what the
  // *message* does. Balance is checked before a wallet can be offered.
  credit(USER_A, 1000)
  const invoice = foreignInvoice()

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    db: {conversations: {added: 1}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invoice review/},
    ],
  })

  const review = e2e.tg.last('sendMessage')
  expect(String(review?.text)).toContain('<blockquote expandable>')
  expect(String(review?.text)).toMatch(/Created:/)
  expect(String(review?.text)).not.toMatch(/Created at:/)
  expect(String(review?.text)).toMatch(/Select a wallet to pay this invoice/)
  expect(String(review?.text)).not.toMatch(/Expires:[\s\S]*?<\/b>\n{3,}<blockquote/)
  expect(review?.link_preview_options).toEqual({is_disabled: true})
  expect(keyboardOf(review)).toEqual(['internal', 'cancel'])
  expectNoErrors(e2e.logs)
})

test('an invoice pasted from Send is deleted and folded into the host review', async () => {
  credit(USER_A, 1000)
  const invoice = foreignInvoice()
  await e2e.send(privateCallback(staticCallback.payInvoice))

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    db: {conversations: {changed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'deleteMessage', to: USER_A},
      {method: 'editMessageText', to: USER_A, text: /Invoice review/},
    ],
  })

  const review = e2e.tg.last('editMessageText')
  expect(String(review?.text)).toMatch(/issued elsewhere/)
  expect(String(review?.text)).toMatch(/Select a wallet to pay this invoice/)
  expect(String(review?.text)).toContain('<blockquote expandable>')
  expect(review?.link_preview_options).toEqual({is_disabled: true})
  expect(keyboardOf(review)).toEqual(['internal', 'cancel'])
  expectNoErrors(e2e.logs)
})

test('an invoice the bot issued itself is paid without a fee-reserve lookup', async () => {
  const pending = await seedRecipientInvoice()
  credit(USER_A, 1000)
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(pending.paymentRequest))
  await e2e.send(confirmWallet())

  const receipt = String(e2e.tg.last('editMessageText')?.text)
  expect(receipt).toMatch(/Fee: <b>0 sats(?: \(\$[^)]+\))?<\/b>/)
  expect(lnPathsSince(mark)).not.toContain('GET /api/v1/payments/fee-reserve')
  expectNoErrors(e2e.logs)
})

test('paying a foreign invoice reports the fee on the receipt', async () => {
  credit(USER_A, 1000)
  await e2e.send(privateText(foreignInvoice().bolt11))
  await e2e.send(confirmWallet())

  const receipt = String(e2e.tg.last('editMessageText')?.text)
  expect(receipt).toMatch(/Fee: <b>\d+ sats(?: \(\$[^)]+\))?<\/b>/)
  expect(receipt).toContain('Wallet: <b>ZapGram</b>')
  expectNoErrors(e2e.logs)
})

test('paying a pending invoice moves the sats, drops the row and notifies the payee', async () => {
  const pending = await seedRecipientInvoice()
  credit(USER_A, 1000)
  await e2e.send(privateText(pending.paymentRequest))
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(confirmWallet()), {
    db: {pendingInvoices: {removed: 1}, conversations: {removed: 1}},
    lnbits: {
      balances: {'100001 wallet': -PENDING_SATS, '100002 wallet': PENDING_SATS},
      payments: [
        {out: false, sats: PENDING_SATS, times: 1},
        {out: true, sats: PENDING_SATS, times: 1},
      ],
    },
    telegram: [
      {method: 'answerCallbackQuery'},
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_B, text: /You received payment for a Lightning invoice/},
      {method: 'editMessageText', to: USER_A, text: /Invoice paid/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })

  // An internal transfer costs nothing, so the payer is debited the invoice amount and no more.
  const receipt = String(e2e.tg.last('editMessageText')?.text)
  expect(receipt).toMatch(
    new RegExp(`Payment amount: <b>${PENDING_SATS} sats(?: \\(\\$[^)]+\\))?</b>`),
  )
  expect(receipt).toMatch(/Fee: <b>0 sats(?: \(\$[^)]+\))?<\/b>/)
  expect(receipt).toMatch(new RegExp(`Total: <b>${PENDING_SATS} sats(?: \\(\\$[^)]+\\))?</b>`))
  expect(receipt).toContain('Wallet: <b>ZapGram</b>')
  expect(receipt).toContain('Description: <b>E2E pending invoice</b>')
  expect(receipt).toContain('<blockquote expandable>')
  expect(receipt).not.toContain('Paying Lightning invoice')
  expect(e2e.tg.last('editMessageText')?.link_preview_options).toEqual({is_disabled: true})
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
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invoice expired/},
    ],
  })

  expect(keyboardOf(e2e.tg.last('sendMessage'))).toEqual([])
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('insufficient balance refuses payment before the review step', async () => {
  const invoice = foreignInvoice()

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Insufficient funds/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
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

  await expectDelta(e2e, () => e2e.send(confirmWallet()), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'answerCallbackQuery'},
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /already been paid/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
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

test('a wallet callback from another review message cannot pay the current invoice', async () => {
  credit(USER_A, 1000)
  await e2e.send(privateText(foreignInvoice().bolt11))
  const currentReviewId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback('internal', {messageId: currentReviewId + 1000})),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'deleteMessage', to: USER_A},
        {method: 'answerCallbackQuery', text: /Unknown button/},
      ],
    },
  )

  expectNoErrors(e2e.logs)
})

// --- Cancel, at every step of every conversation ---

const cancelCases: {
  conversation: string
  step: string
  reach: () => Promise<void>
  lifecyclePrompt: 'text' | 'memo' | 'host'
  parentText: RegExp
  parentMethod?: 'sendMessage' | 'sendRichMessage'
}[] = [
  {
    conversation: creatingInvoice.name,
    step: 'amount',
    reach: enterCreateInvoiceAtAmount,
    lifecyclePrompt: 'host',
    parentText: /Wallet/,
    parentMethod: 'sendRichMessage',
  },
  {
    conversation: creatingInvoice.name,
    step: 'memo',
    reach: enterCreateInvoiceAtMemo,
    lifecyclePrompt: 'memo',
    parentText: /Wallet/,
    parentMethod: 'sendRichMessage',
  },
  {
    conversation: payingInvoice.name,
    step: 'invoice',
    reach: enterPayInvoiceAtInvoice,
    lifecyclePrompt: 'host',
    parentText: /Send payment/,
  },
  {
    conversation: payingInvoice.name,
    step: 'wallet',
    reach: enterPayInvoiceAtReview,
    lifecyclePrompt: 'host',
    // This fixture reaches review by pasting an invoice, so no Send screen was active before it.
    parentText: /Wallet/,
    parentMethod: 'sendRichMessage',
  },
  {
    conversation: connectingNWC.name,
    step: 'url',
    reach: enterConnectNwcAtUrl,
    lifecyclePrompt: 'text',
    parentText: /Settings/,
  },
  {
    conversation: sendingToUser.name,
    step: 'username',
    reach: enterSendToUserAtUsername,
    lifecyclePrompt: 'host',
    parentText: /Send payment/,
  },
  {
    conversation: sendingToUser.name,
    step: 'amount',
    reach: enterSendToUserAtAmount,
    lifecyclePrompt: 'host',
    parentText: /Send payment/,
  },
  {
    conversation: changingPrice.name,
    step: 'price',
    reach: enterChangePriceAtPrice,
    lifecyclePrompt: 'host',
    parentText: /E2E paid chat/,
  },
  {
    conversation: editCustomMessage.name,
    step: 'russian',
    reach: enterCustomMessageAtRussian,
    lifecyclePrompt: 'text',
    parentText: /Join request message/,
  },
  {
    conversation: editCustomMessage.name,
    step: 'english',
    reach: enterCustomMessageAtEnglish,
    lifecyclePrompt: 'text',
    parentText: /Join request message/,
  },
]

for (const {conversation, step, reach, lifecyclePrompt, parentText, parentMethod} of cancelCases) {
  test(`cancel at the ${step} step of ${conversation} returns to its parent screen`, async () => {
    await reach()
    const update = privateCallback(staticCallback.cancel, {messageId: requiredPromptMessageId()})
    const parent = {
      method: parentMethod ?? ('sendMessage' as const),
      to: USER_A,
      text: parentText,
    }
    const telegram =
      lifecyclePrompt === 'host'
        ? [
            {method: 'answerCallbackQuery'},
            {method: 'editMessageText', to: USER_A, text: parentText},
          ]
        : lifecyclePrompt === 'memo'
          ? [
              {method: 'answerCallbackQuery'},
              {method: 'editMessageMedia', to: USER_A, text: /Amount:/},
              parent,
            ]
          : [
              {method: 'answerCallbackQuery'},
              {method: 'editMessageText', to: USER_A, text: /Action canceled/},
              parent,
            ]

    await expectDelta(e2e, () => e2e.send(update), {
      db: {conversations: {removed: 1}},
      telegram,
    })

    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('the shared registry contains all twelve conversations', () => {
  expect(registeredConversations.map(conversation => conversation.name).sort()).toEqual(
    [
      'broadcasting',
      'changingPrice',
      'connectingNWC',
      'creatingInvoice',
      'customDonateAmount',
      'customDonationPercent',
      'customMonthlyAmount',
      'editCustomMessage',
      'enablingOnchain',
      'payingInvoice',
      'requestingFeature',
      'sendingToUser',
    ].sort(),
  )
})

// --- Input a step cannot use ---

test('a memo longer than 150 characters keeps the existing no-memo invoice', async () => {
  await enterCreateInvoiceAtMemo()

  await expectDelta(e2e, () => e2e.send(privateText('m'.repeat(151))), {
    db: {conversations: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /Invalid memo/}],
  })

  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)

  await expectDelta(e2e, () => e2e.send(privateText(MEMO)), {
    db: {conversations: {removed: 1}, pendingInvoices: {added: 1}},
    lnbits: {payments: [{out: false, sats: AMOUNT, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'editMessageMedia', to: USER_A, text: /Description:/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })

  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(2)
  expectNoErrors(e2e.logs)
})

test('ordinary text on the QR step drops the buttons and opens Wallet', async () => {
  await enterCreateInvoiceAtQr()
  const qrMessageId = requiredInvoiceHostMessageId()

  await expectDelta(e2e, () => e2e.send(privateText('add a memo')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageCaption', to: USER_A, text: /no longer active/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })

  expect(e2e.tg.last('editMessageCaption')).toMatchObject({
    message_id: qrMessageId,
    reply_markup: {inline_keyboard: []},
  })
  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('a bolt11 on the QR step drops the buttons and starts payment review', async () => {
  await enterCreateInvoiceAtQr()
  const qrMessageId = requiredInvoiceHostMessageId()
  credit(USER_A, 1000)
  const invoice = foreignInvoice()

  await expectDelta(e2e, () => e2e.send(privateText(invoice.bolt11)), {
    db: {conversations: {changed: 1}},
    telegram: [
      {method: 'editMessageCaption', to: USER_A, text: /no longer active/},
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Invoice review/},
    ],
  })

  expect(e2e.tg.last('editMessageCaption')).toMatchObject({
    message_id: qrMessageId,
    reply_markup: {inline_keyboard: []},
  })
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Select a wallet to pay this invoice/)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('ordinary text on invoice review does not confirm payment', async () => {
  await enterPayInvoiceAtReview()
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(privateText('pay')), {
    db: {conversations: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /buttons on the active message/}],
  })

  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('a callback from another message deactivates the QR and starts its own flow', async () => {
  await enterCreateInvoiceAtQr()
  const qrMessageId = requiredInvoiceHostMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(staticCallback.payInvoice, {messageId: qrMessageId + 1000})),
    {
      db: {conversations: {changed: 1}},
      telegram: [
        {method: 'editMessageCaption', to: USER_A, text: /no longer active/},
        {method: 'editMessageText', to: USER_A, text: /Send or forward a message/},
      ],
    },
  )

  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('/wallet during memo input deactivates both memo prompts and keeps the invoice valid', async () => {
  await enterCreateInvoiceAtMemo()

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageCaption', to: USER_A, text: /Action canceled/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })

  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

const invalidCases: {
  label: string
  reach: () => Promise<void>
  input: () => Update
  error: RegExp
  correct: () => Promise<void>
}[] = [
  {
    label: 'a word where an amount belongs',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('abc'),
    error: /Invalid amount of sats/,
    correct: () => e2e.send(privateText(String(AMOUNT))),
  },
  {
    label: 'an amount of zero',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('0'),
    error: /Invalid amount of sats/,
    correct: () => e2e.send(privateText(String(AMOUNT))),
  },
  {
    label: 'a negative amount',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('-5'),
    error: /Invalid amount of sats/,
    correct: () => e2e.send(privateText(String(AMOUNT))),
  },
  {
    label: 'an amount above the maximum',
    reach: enterCreateInvoiceAtAmount,
    input: () => privateText('100000001'),
    error: /Invalid amount of sats/,
    correct: () => e2e.send(privateText(String(AMOUNT))),
  },
  {
    label: 'a message with no invoice in it',
    reach: enterPayInvoiceAtInvoice,
    input: () => privateText('pay me back sometime'),
    error: /Invalid Lightning invoice/,
    correct: async () => {
      credit(USER_A, 1000)
      await e2e.send(privateText(foreignInvoice().bolt11))
    },
  },
  {
    label: 'a username without its @',
    reach: enterSendToUserAtUsername,
    input: () => privateText('user_b'),
    error: /Invalid username/,
    correct: async () => {
      await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
      e2e.tg.reply('getChat', {
        id: USER_B,
        type: 'private',
        username: 'user_b',
        first_name: 'User B',
      })
      await e2e.send(privateText('@user_b'))
    },
  },
]

for (const {label, reach, input, error, correct} of invalidCases) {
  test(`${label} keeps the current prompt active and accepts a correction`, async () => {
    await reach()

    await expectDelta(e2e, () => e2e.send(input()), {
      db: {conversations: {changed: 1}},
      telegram: [{method: 'sendMessage', to: USER_A, text: error}],
    })

    expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)
    expect(keyboardOf(e2e.tg.last('sendMessage'))).toEqual([])
    expect(
      e2e.tg
        .of('sendMessage')
        .map(call => String(call.text))
        .join('\n'),
    ).not.toMatch(/Action canceled|<b>👛 Wallet/)

    await correct()

    expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)
    expectNoErrors(e2e.logs)
  })
}

test('a custom message can be corrected after invalid media and excessive length', async () => {
  await enterCustomMessageAtRussian()
  await e2e.send(privatePhoto())
  await e2e.send(privateText('x'.repeat(1001)))

  await expectDelta(e2e, () => e2e.send(privateText('Привет')), {
    db: {chats: {changed: 1}, conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /RU custom message has been updated/},
      {method: 'sendMessage', to: USER_A, text: /Join request message/},
    ],
  })
  expect(await e2e.container.chats.getOrThrow(CHAT_GROUP)).toMatchObject({
    customMessageRu: 'Привет',
    customMessageEn: 'Keep English',
  })
  expectNoErrors(e2e.logs)
})

// --- Living alongside the rest of the bot ---

// docs/known-issues.md — every conversation is installed above every command, so /wallet
// always cancels the active conversation (uniform rule; no registration-order asymmetry).
test('/wallet cancels creatingInvoice waiting for an amount', async () => {
  await enterCreateInvoiceAtAmount()

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageText', to: USER_A, text: /Action canceled/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('/wallet cancels connectingNWC waiting for a URL', async () => {
  await enterConnectNwcAtUrl()

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageText', to: USER_A, text: /Action canceled/},
      {method: 'sendRichMessage', to: USER_A, text: /Balance:/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('/help interrupts a number step and opens Help without a validation error', async () => {
  await enterChangePriceAtPrice()

  await expectDelta(e2e, () => e2e.send(privateCommand('/help')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageText', to: USER_A, text: /Action canceled/},
      {method: 'sendRichMessage', to: USER_A, text: /Bitcoin/},
    ],
  })

  expect(
    e2e.tg
      .of('sendMessage')
      .map(call => String(call.text))
      .join('\n'),
  ).not.toMatch(/Invalid amount of sats/)
  expectNoErrors(e2e.logs)
})

test('/chats interrupts a callback-only review and opens the chat list', async () => {
  await enterPayInvoiceAtReview()
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageText', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /chats with the ability/},
    ],
  })

  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

test('an action callback from another message interrupts the flow and shows its own feedback', async () => {
  await enterCreateInvoiceAtAmount()
  const promptMessageId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(donationPercentRoute.build({percent: 10}), {
          messageId: promptMessageId + 1000,
        }),
      ),
    {
      db: {users: {changed: 1}, conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'editMessageText', to: USER_A, text: /Auto %/},
        {method: 'answerCallbackQuery', text: /10%/},
      ],
    },
  )

  expect((await e2e.container.users.findById(USER_A))?.donationPercent).toBe(10)
  expectNoErrors(e2e.logs)
})

test('an unknown callback interrupts the flow, reaches fallback and closes its spinner', async () => {
  await enterCreateInvoiceAtAmount()
  const promptMessageId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback('no-such-route', {messageId: promptMessageId + 1000})),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'deleteMessage', to: USER_A},
        {method: 'answerCallbackQuery', text: /Unknown button/},
      ],
    },
  )

  expectNoErrors(e2e.logs)
})

test('a stale Cancel interrupts the current flow and terminal Cancel opens Wallet', async () => {
  await enterCreateInvoiceAtAmount()
  const promptMessageId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(staticCallback.cancel, {messageId: promptMessageId + 1000})),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'sendRichMessage', to: USER_A, text: /Wallet/},
      ],
    },
  )

  expectNoErrors(e2e.logs)
})

test('prompt edit failure does not block Help or leave a conversation row', async () => {
  await enterCreateInvoiceAtAmount()
  const promptMessageId = requiredPromptMessageId()
  e2e.tg.fail('editMessageText', {
    error_code: 400,
    description: 'Bad Request: message to edit not found',
  })

  await e2e.send(privateCommand('/help'))

  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('editMessageText')[0]).toMatchObject({message_id: promptMessageId})
  expect(e2e.tg.of('editMessageReplyMarkup')[0]).toMatchObject({message_id: promptMessageId})
  const messages = e2e.tg.of('sendMessage').map(call => String(call.text))
  expect(messages.some(text => /Previous action canceled/.test(text))).toBe(true)
  const richMessages = e2e.tg
    .of('sendRichMessage')
    .map(call => String((call.rich_message as {html?: string} | undefined)?.html))
  expect(richMessages.some(text => /Bitcoin/.test(text))).toBe(true)
  expectNoErrors(e2e.logs)
})

test('a persisted text prompt keeps its message ID when interrupted after restart', async () => {
  await e2e.dispose()
  e2e = await createE2E({
    mode: 'file',
    env: {BOT_USERNAME: 'zap_gram_bot'},
  })
  await enterCreateInvoiceAtAmount()
  const promptMessageId = requiredPromptMessageId()

  await e2e.restart()
  await e2e.send(privateCommand('/wallet'))

  await expectNoConversations(e2e.db)
  expect(e2e.tg.last('editMessageText')).toMatchObject({message_id: promptMessageId})
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Action canceled/)
  expect(richHtmlOf(e2e.tg.last('sendRichMessage'))).toMatch(/Wallet/)
  expectNoErrors(e2e.logs)
})

test('starting another conversation cancels the one in progress', async () => {
  await enterCreateInvoiceAtAmount()
  const oldPromptId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(staticCallback.payInvoice, {messageId: oldPromptId + 1000})),
    {
      db: {conversations: {changed: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'editMessageText', to: USER_A, text: /Send or forward a message/},
      ],
    },
  )

  expect(await e2e.db.select().from(conversationsTable)).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('cancel outside a conversation just re-renders the wallet', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
    telegram: [{method: 'sendRichMessage', to: USER_A, text: /Balance:/}],
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
  await openMemoPrompt()
}

async function openMemoPrompt(): Promise<void> {
  const messageId = requiredInvoiceHostMessageId()
  await e2e.send(privateCallback(staticCallback.addInvoiceMemo, {messageId}))
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
  await enterCustomMessage('ru')
}

async function enterCustomMessageAtEnglish(): Promise<void> {
  await enterCustomMessage('en')
}

async function enterCustomMessage(locale: 'ru' | 'en'): Promise<void> {
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    customMessageEn: 'Keep English',
  })
  await e2e.send(privateCallback(chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale})))
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

/** The wallet picker button that now both chooses the rail and pays. */
function confirmWallet(): Update {
  return privateCallback('internal', {messageId: requiredPromptMessageId()})
}

function keyboardOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function richHtmlOf(payload: Record<string, unknown> | undefined): string {
  const richMessage = payload?.rich_message
  if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
  return String(Reflect.get(richMessage, 'html') ?? '')
}

function requiredPromptMessageId(): number {
  const edited = e2e.tg.lastMessageId('editMessageText')
  if (edited !== undefined) return edited
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound text prompt message ID')
  return messageId
}

function requiredInvoiceHostMessageId(): number {
  const messageId =
    e2e.tg.lastMessageId('editMessageMedia') ?? e2e.tg.lastMessageId('editMessageText')
  if (messageId === undefined) throw new Error('Expected an outbound invoice host message ID')
  return messageId
}

function lastInvoiceCaption(): string {
  const media = e2e.tg.last('editMessageMedia')?.media
  if (!media || typeof media !== 'object' || Array.isArray(media)) return ''
  return String(Reflect.get(media, 'caption') ?? '')
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
