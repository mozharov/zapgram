import {afterEach, beforeEach, expect, test} from 'bun:test'
import {subscriptionPaymentsTable} from '@infra/db/schema.js'
import {expectNoErrors} from '../asserts.js'
import {CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedSubscriptionPayment, seedUser} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  groupText,
  privateCallback,
  privateText,
  type UnhandledUpdateType,
  unhandledUpdate,
  unhandledUpdateTypes,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.input

/**
 * What the bot does with input it was not designed for: update types nobody handles, the same
 * update delivered twice, and malformed text and callback data.
 *
 * The bar for every case is the same — no unhandled exception, and a world that only changed in
 * ways the test names. Where the current behaviour is wrong rather than merely surprising, the
 * test pins what actually happens and points at the entry in `docs/known-issues.md`.
 */

/** A fresh user, so `users.added: 1` is the whole DB delta of a first-touch update. */
const FIRST_TOUCH = {
  db: {users: {added: 1}},
  lnbits: {balances: {'100001 wallet': 0}},
} as const

const UNKNOWN_UUID = '0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f'
const TIP_PRICE = 21
const CHAT_PRICE = 100

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Update types nothing handles ---

/**
 * These two arrive in a private chat, and the private composer runs `attachUser` and
 * `lnbitsWallet` ahead of every command and callback filter. So editing a message or reacting to
 * one still provisions the sender: a `users` row and an LNbits wallet, but no reply.
 */
const PROVISIONS_SENDER = new Set<UnhandledUpdateType>(['edited_message', 'message_reaction'])

for (const type of unhandledUpdateTypes) {
  test(`an ${type} update produces no reply`, async () => {
    const update = unhandledUpdate(type)
    // The payload really is under that key and really is populated: an update the bot ignores
    // because the fixture built it wrong would pass this test for the wrong reason.
    expect(Object.keys(update).filter(key => key !== 'update_id' && key !== 'reqId')).toEqual([
      type,
    ])
    expect(Object.keys(Reflect.get(update, type) as object).length).toBeGreaterThan(2)

    await expectDelta(e2e, () => e2e.send(update), PROVISIONS_SENDER.has(type) ? FIRST_TOUCH : {})
    expectNoErrors(e2e.logs)
  })
}

test('the ignored update types are the ones Telegram can deliver to this bot', () => {
  const covered: UnhandledUpdateType[] = [...unhandledUpdateTypes]
  expect(covered).toHaveLength(11)
  expect(new Set(covered).size).toBe(covered.length)
})

// --- The same update delivered twice ---

test('a redelivered join request resends the method chooser without minting an invoice', async () => {
  await seedUser(e2e, {id: OWNER})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: CHAT_PRICE})
  const update = chatJoinRequest('supergroup', {from: {id: USER_A}})
  await e2e.send(update)

  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Choose a payment method/)
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])

  // Telegram can redeliver an update it never got a 200 for. Chooser is re-sent; no invoice yet.
  await expectDelta(e2e, () => e2e.send(update), {
    telegram: [
      {
        method: 'sendMessage',
        to: USER_A,
        text: /Choose a payment method/,
      },
    ],
  })

  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expectNoErrors(e2e.logs)
})

test('a redelivered /tip sends the sats a second time', async () => {
  await seedTippers()
  const update = groupText(`/tip ${TIP_PRICE} @user_b`, {from: {id: USER_A, username: 'user_a'}})
  await e2e.send(update)

  // Deliberate, not a defect: a tip is a command, and a command the user issued twice pays twice.
  // Redelivery is indistinguishable from that here, and the amount is small and bounded.
  await expectDelta(e2e, () => e2e.send(update), {
    lnbits: {
      balances: {'100001 wallet': -TIP_PRICE, '100002 wallet': TIP_PRICE},
      payments: [
        {out: false, sats: TIP_PRICE, times: 1},
        {out: true, sats: TIP_PRICE, times: 1},
      ],
    },
    telegram: [
      {method: 'deleteMessage'},
      {method: 'sendChatAction'},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @user_b/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('paying the same subscription invoice twice does not debit twice', async () => {
  await seedUser(e2e, {id: OWNER})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: CHAT_PRICE})
  const payment = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    paid: false,
    price: CHAT_PRICE,
  })
  credit(USER_A, 1000)
  const update = privateCallback(`pay-sub:${payment.id}:wallet`)
  await e2e.send(update)

  // The payment row outlives the click — only the settle cron deletes it — so the second click
  // reaches the same invoice. LNbits is what refuses it, and the refusal is what the user sees.
  await expectDelta(e2e, () => e2e.send(update), {
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /already been paid/},
      {method: 'sendMessage', to: USER_A, text: /Wallet/},
    ],
  })
  expect(errorMessages()).toEqual([
    'POST /api/v1/payments: HTTP error',
    'Error paying invoice',
    'Bot error',
  ])
})

// --- Malformed input ---

const textCases: {label: string; text: string}[] = [
  {label: 'an empty message', text: ''},
  {label: 'a 4096-character message', text: 'a'.repeat(4096)},
  {label: 'emoji and right-to-left text', text: '⚡️⚡️ مرحبا بالعالم ⚡️'},
]

for (const {label, text} of textCases) {
  test(`${label} falls back to the wallet like any other text`, async () => {
    await expectDelta(e2e, () => e2e.send(privateText(text)), {
      ...FIRST_TOUCH,
      telegram: [{method: 'sendMessage', to: USER_A, text: /Wallet/}],
    })
    expectNoErrors(e2e.logs)
  })
}

const unroutableCallbacks: {label: string; data: string}[] = [
  {label: 'a chat id with a statement appended', data: 'chat:-1;DROP'},
  {label: 'a subscription id that is not a uuid', data: 'subscription:не-uuid'},
  {label: 'an unknown payment source', data: `pay-sub:${UNKNOWN_UUID}:неизвестно`},
]

for (const {label, data} of unroutableCallbacks) {
  test(`${label} is answered as an unknown button`, async () => {
    const chat = await seedRoutableChat()

    await expectDelta(e2e, () => e2e.send(privateCallback(data)), {
      ...FIRST_TOUCH,
      telegram: ['deleteMessage', 'answerCallbackQuery'],
    })
    expect(e2e.tg.last('answerCallbackQuery')?.text).toMatch(/Unknown button/)
    // The route patterns are anchored, so none of these reach a handler — but the chat the
    // injected statement names must still be there afterwards.
    expect(await e2e.container.chats.findAccessibleById(chat.id)).toMatchObject({
      title: chat.title,
    })
    expectNoErrors(e2e.logs)
  })
}

test('a chat id too large for a Number reaches the handler and finds no chat', async () => {
  await seedRoutableChat()

  // 1e20 survives the `-?\d+` pattern and parseInt, so this one does route — the handler has to
  // cope with an id no chat can have rather than throw.
  await expectDelta(e2e, () => e2e.send(privateCallback('chat:99999999999999999999')), {
    ...FIRST_TOUCH,
    telegram: [{method: 'editMessageText', to: USER_A, text: /Chat not found/}],
  })
  expectNoErrors(e2e.logs)
})

// --- Usernames ---

test('a tip to someone without a username names them by first name', async () => {
  await seedTippers({recipientUsername: undefined, recipientFirstName: 'No Handle'})
  const update = groupText(`/tip ${TIP_PRICE}`, {from: {id: USER_A, username: 'user_a'}})
  const message = update.message
  if (!message) throw new Error('groupText did not create a message')
  message.reply_to_message = {
    message_id: 4242,
    date: Math.floor(Date.now() / 1000),
    text: 'worth a tip',
    from: {id: USER_B, is_bot: false, first_name: 'No Handle'},
    chat: message.chat,
    reply_to_message: undefined,
  }

  await expectDelta(e2e, () => e2e.send(update), {
    lnbits: {
      balances: {'100001 wallet': -TIP_PRICE, '100002 wallet': TIP_PRICE},
      payments: [
        {out: false, sats: TIP_PRICE, times: 1},
        {out: true, sats: TIP_PRICE, times: 1},
      ],
    },
    telegram: [
      {method: 'deleteMessage'},
      {method: 'sendChatAction'},
      {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to No Handle/},
      {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
    ],
  })
  expectNoErrors(e2e.logs)
})

test('a handle the recipient no longer owns stops resolving', async () => {
  await seedTippers({recipientUsername: 'old_handle'})
  await renameRecipient('new_handle')

  await expectDelta(
    e2e,
    () => e2e.send(groupText('/tip 21 @old_handle', {from: {id: USER_A, username: 'user_a'}})),
    {
      telegram: [
        {method: 'deleteMessage'},
        {method: 'sendChatAction'},
        {
          method: 'sendMessage',
          to: CHAT_GROUP,
          receiverUserId: USER_A,
          text: /doesn't have a ZapGram wallet/,
        },
      ],
    },
  )
  expect(errorMessages()).toEqual(['Bot error'])
})

test('the new handle reaches the same recipient', async () => {
  await seedTippers({recipientUsername: 'old_handle'})
  await renameRecipient('new_handle')

  await expectDelta(
    e2e,
    () => e2e.send(groupText('/tip 21 @new_handle', {from: {id: USER_A, username: 'user_a'}})),
    {
      lnbits: {
        balances: {'100001 wallet': -TIP_PRICE, '100002 wallet': TIP_PRICE},
        payments: [
          {out: false, sats: TIP_PRICE, times: 1},
          {out: true, sats: TIP_PRICE, times: 1},
        ],
      },
      telegram: [
        {method: 'deleteMessage'},
        {method: 'sendChatAction'},
        {method: 'sendMessage', to: CHAT_GROUP, text: /sent 21 sats to @new_handle/},
        {method: 'sendMessage', to: USER_B, text: /You received 21 sats/},
      ],
    },
  )
  expectNoErrors(e2e.logs)
})

async function seedTippers(
  opts: {recipientUsername?: string; recipientFirstName?: string} = {recipientUsername: 'user_b'},
): Promise<void> {
  // The names have to match what the update fixtures report, or `attachUser` refreshes the row
  // mid-action and every delta grows a users change the test did not ask about.
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {
    id: USER_B,
    username: opts.recipientUsername,
    firstName: opts.recipientFirstName ?? 'User B',
  })
  credit(USER_A, 1000)
}

/** Telegram reports the new handle on the next update from that user; `attachUser` stores it. */
async function renameRecipient(username: string): Promise<void> {
  await e2e.send(privateText('hi', {from: {id: USER_B, username, first_name: 'User B'}}))
  expect(await e2e.container.users.findById(USER_B)).toMatchObject({username})
  e2e.tg.reset()
}

async function seedRoutableChat() {
  await seedUser(e2e, {id: OWNER})
  return seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: CHAT_PRICE})
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
