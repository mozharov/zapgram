import {afterEach, beforeEach, expect, test} from 'bun:test'
import type {AppErrorCode} from '@core/errors/app-error.js'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {NoNWCAnswerError} from '@core/errors/no-nwc-answer.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {chatsTable, usersTable} from '@infra/db/schema.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {
  payLightningRoute,
  paySubscriptionRoute,
  subscriptionRoute,
} from '@telegram/callback-data.js'
import {errorTranslationKey} from '@telegram/errors/error-copy.js'
import {translate} from '@telegram/i18n/i18n.js'
import {eq} from 'drizzle-orm'
import {mintInvoice} from '../fakes/bolt11.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {
  seedChat,
  seedPendingInvoice,
  seedSubscription,
  seedSubscriptionPayment,
  seedUser,
} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  groupReply,
  groupText,
  myChatMember,
  privateCallback,
  privateCommand,
  privateText,
  type TestUpdate,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

/**
 * Domain errors as the user sees them: every AppErrorCode reaches the right Fluent copy, private
 * chats get error + wallet, group failures reach only their sender, channels stay silent, and copy
 * is free of Fluent isolation marks and raw translation keys.
 *
 * `not_found` intentionally maps to `error.unknown`. NWC payment failures are forced through the
 * real pay-subscription route by stubbing `NostrWallet.prototype.payInvoice` — the live NWC
 * transport itself belongs to the dedicated NWC suite (step 4.13).
 */

const RAW_KEY = /\{[a-z0-9.-]+\}/i
const FLUENT_MARKS = /[\u2068\u2069]/
const NWC_URL = `nostr+walletconnect://${'aa'.repeat(32)}?relay=wss://relay.example&secret=${'bb'.repeat(32)}`

type Locale = 'en' | 'ru'

const ALL_CODES: AppErrorCode[] = [
  'insufficient_funds',
  'invoice_already_paid',
  'invoice_generation_failed',
  'invoice_parsing',
  'nwc_timeout',
  'nwc_connection',
  'nwc_payment_failed',
  'nwc_no_answer',
  'no_recipient',
  'to_bot',
  'from_bot',
  'to_yourself',
  'user_has_no_wallet',
  'not_found',
  'unknown',
]

export const COVERS = scenarioCoverage.errors

let e2e: E2E
let restorePayInvoice: (() => void) | undefined

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'en',
  })
})

afterEach(async () => {
  restorePayInvoice?.()
  restorePayInvoice = undefined
  await e2e.dispose()
})

// --- Full AppErrorCode matrix ---

test('error-copy maps every AppErrorCode, with not_found falling back to unknown', () => {
  expect(Object.keys(errorTranslationKey).sort()).toEqual([...ALL_CODES].sort())
  expect(errorTranslationKey.not_found).toBe('error.unknown')
  expect(errorTranslationKey.unknown).toBe('error.unknown')
  for (const code of ALL_CODES) {
    const key = errorTranslationKey[code]
    for (const locale of ['en', 'ru'] as const) {
      const text = translate(key, locale)
      expectCleanUserText(text)
      if (code === 'not_found' || code === 'unknown') {
        expect(text).toMatch(locale === 'en' ? /Unknown error occurred/ : /неизвестная ошибка/i)
      } else {
        expect(text).not.toMatch(locale === 'en' ? /Unknown error occurred/ : /неизвестная ошибка/i)
      }
    }
  }
})

test('insufficient_funds is shown in a group only to the sender', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  await expectGroupError(groupText('/tip 21 @user_b'), 'insufficient_funds', 'en')
})

test('insufficient_funds in private chat is error text plus the wallet screen', async () => {
  const invoice = mintInvoice({sats: 100, description: 'too expensive'})
  const before = await snapshot(e2e)

  // Balance is checked when choosing a wallet, before the review / pay button.
  await e2e.send(privateText(invoice.bolt11))

  expectPrivateErrorAndWallet('insufficient_funds', 'en')
  await expectMoneyUnchanged(before)
})

test('invoice_already_paid keeps the payee pending row and shows the dedicated copy', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  const pending = await seedPendingInvoice(e2e, {userId: USER_B, sats: 21})
  credit(USER_A, 1000)
  e2e.ln.state.payInvoice({payerWallet: walletOf(USER_A), bolt11: pending.paymentRequest})
  await e2e.send(privateText(pending.paymentRequest))
  const before = await snapshot(e2e)

  await e2e.send(privateCallback(payButton(), {messageId: requiredPromptMessageId()}))

  expectPrivateErrorAndWallet('invoice_already_paid', 'en')
  const after = await snapshot(e2e)
  expect(after.db.pendingInvoices).toEqual(before.db.pendingInvoices)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
})

test('invoice_parsing rejects a bolt11-shaped but undecodable payment request', async () => {
  const before = await snapshot(e2e)

  await e2e.send(privateText('lnbc1notavalidinvoice00'))

  expectPrivateErrorAndWallet('invoice_parsing', 'en')
  // Conversation enters before decode, so the opening "Paying..." line is also present.
  expect(
    e2e.tg.of('sendMessage').some(call => String(call.text).includes('Paying Lightning invoice')),
  ).toBe(true)
  await expectMoneyUnchanged(before)
})

test('invoice_generation_failed is DMed when a join Lightning invoice cannot be minted', async () => {
  await seedOwnerAndChat()
  await e2e.send(
    chatJoinRequest('supergroup', {
      from: {id: USER_A, username: 'user_a', first_name: 'User A', language_code: 'en'},
    }),
  )
  const chooser = e2e.tg.last('sendMessage')
  e2e.ln.state.failNext(
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: body => body !== null && typeof body === 'object' && Reflect.get(body, 'out') === false,
    },
    {status: 520, body: {status: 'failed', detail: 'backend unavailable'}},
  )

  await e2e.send(
    privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
      from: {id: USER_A, username: 'user_a', first_name: 'User A', language_code: 'en'},
      messageId: Number(chooser?.message_id ?? 1),
    }),
  )

  const expected = expectedErrorText('invoice_generation_failed', 'en')
  const texts = e2e.tg.of('sendMessage').map(call => String(call.text))
  expect(texts).toContain(expected)
  expectCleanUserText(expected)
  expect(errorMessages().some(message => message === 'Bot error')).toBe(true)
})

test('nwc_connection is raised when paying a subscription invoice via NWC without a wallet', async () => {
  await seedOwnerAndChat()
  const payment = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: false,
    price: 1000,
  })
  const before = await snapshot(e2e)

  await e2e.send(privateCallback(paySubscriptionRoute.build({paymentId: payment.id, from: 'nwc'})))

  expectPrivateErrorAndWallet('nwc_connection', 'en')
  await expectMoneyUnchanged(before)
})

for (const scenario of [
  {
    code: 'nwc_timeout' as const,
    throwError: () => new NWCTimeoutError(),
  },
  {
    code: 'nwc_payment_failed' as const,
    throwError: () => new NWCPaymentFailedError(),
  },
  {
    code: 'nwc_no_answer' as const,
    throwError: () => new NoNWCAnswerError(),
  },
]) {
  test(`${scenario.code} reaches the user through the NWC pay-subscription path`, async () => {
    await seedOwnerAndChat()
    await e2e.container.users.update(USER_A, {nwcUrl: NWC_URL})
    const payment = await seedSubscriptionPayment(e2e, {
      userId: USER_A,
      chatId: CHAT_GROUP,
      paid: false,
      price: 1000,
    })
    stubNwcPayInvoice(() => {
      throw scenario.throwError()
    })
    const before = await snapshot(e2e)

    await e2e.send(
      privateCallback(paySubscriptionRoute.build({paymentId: payment.id, from: 'nwc'})),
    )

    expectPrivateErrorAndWallet(scenario.code, 'en')
    await expectMoneyUnchanged(before)
  })
}

test('no_recipient is reported when a group tip has no discoverable creator', async () => {
  e2e.tg.reply('getChatAdministrators', [])
  await expectGroupError(groupText('/tip'), 'no_recipient', 'en')
})

test('to_bot refuses a tip reply to a bot account', async () => {
  await expectGroupError(
    groupReply(
      '/tip 21',
      {
        text: 'bot message',
        from: {id: 900001, is_bot: true, username: 'helper_bot', first_name: 'Helper'},
      },
      {from: {id: USER_A, username: 'user_a'}},
    ),
    'to_bot',
    'en',
  )
})

test('from_bot rejects a private update from a bot account before creating a user', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('hello', {from: {is_bot: true}})), {
    telegram: [{method: 'sendMessage', to: USER_A, text: expectedErrorPattern('from_bot', 'en')}],
  })
  // Seeded USER_A remains; the bot-from update creates nobody.
  expect(await e2e.db.select().from(usersTable)).toEqual([expect.objectContaining({id: USER_A})])
  expect(errorTextTo(USER_A)).toBe(expectedErrorText('from_bot', 'en'))
  expectCleanUserText(errorTextTo(USER_A))
  // attachUser throws before ctx.user/wallet exist; replyWithCachedWallet no-ops quietly.
  expect(errorMessages()).toEqual(['Bot error'])
})

test('to_yourself refuses a tip to the sender username', async () => {
  await expectGroupError(groupText('/tip 21 @user_a'), 'to_yourself', 'en')
})

test('user_has_no_wallet refuses a tip to an unknown username', async () => {
  await expectGroupError(groupText('/tip 21 @missing_user'), 'user_has_no_wallet', 'en')
})

test('not_found is intentionally shown as the unknown error copy', async () => {
  await seedOwnerAndChat()
  const subscription = await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: 1000,
  })
  // Leave a subscription whose chat row is gone so findByIdWithChat hits not_found.
  const client = Reflect.get(e2e.db, '$client') as {run: (sql: string) => void}
  client.run('PRAGMA foreign_keys = OFF')
  await e2e.db.delete(chatsTable).where(eq(chatsTable.id, CHAT_GROUP))
  client.run('PRAGMA foreign_keys = ON')
  const before = await snapshot(e2e)

  await e2e.send(privateCallback(subscriptionRoute.build({subscriptionId: subscription.id})))

  expectPrivateErrorAndWallet('not_found', 'en')
  expect(errorTextTo(USER_A)).toBe(expectedErrorText('unknown', 'en'))
  await expectMoneyUnchanged(before)
})

test('unknown surfaces for a non-AppError failure', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, 1000)
  const original = e2e.container.getUserWallet
  e2e.container.getUserWallet = async userId => {
    const wallet = await original(userId)
    return Object.assign(wallet, {
      payInvoice: async () => {
        throw new Error('Injected non-domain failure')
      },
    })
  }

  try {
    await expectGroupError(groupText('/tip 21 @user_b'), 'unknown', 'en')
  } finally {
    e2e.container.getUserWallet = original
  }
})

// --- Delivery modes ---

test('a group error is an ephemeral message that needs no cleanup', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(groupText('/tip 21 @user_b')), {
    telegram: [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: USER_A,
        text: expectedErrorPattern('insufficient_funds', 'en'),
      },
    ],
  })

  const after = await snapshot(e2e)
  expect(after.db).toEqual(before.db)
  expect(after.lnbits).toEqual(before.lnbits)
  expect(errorMessages()).toEqual(['Bot error'])
})

test('a group error Telegram refuses to keep private falls back to a public temporary message', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  // Only the ephemeral attempt fails; the public fallback takes the next queued (default) response.
  e2e.tg.fail('sendMessage', {error_code: 400, description: 'Bad Request: user not found'})

  await expectDelta(e2e, () => sendAndWaitForTempMessage(groupText('/tip 21 @user_b')), {
    telegram: [
      {method: 'deleteMessage', to: CHAT_GROUP},
      {method: 'sendChatAction', to: CHAT_GROUP},
      {method: 'sendMessage', to: CHAT_GROUP, receiverUserId: USER_A},
      {
        method: 'sendMessage',
        to: CHAT_GROUP,
        receiverUserId: null,
        text: expectedErrorPattern('insufficient_funds', 'en'),
      },
      {method: 'deleteMessages', to: CHAT_GROUP},
    ],
  })

  expect(errorMessages()).toEqual(['Bot error'])
})

test('a channel error is silent', async () => {
  // Force an AppError inside the channel my_chat_member path; the error handler must not reply.
  const original = e2e.container.users.getOrCreate
  e2e.container.users.getOrCreate = async () => {
    throw new InsufficientFundsError()
  }
  const before = await snapshot(e2e)
  const telegramMark = e2e.tg.calls.length

  try {
    await e2e.send(myChatMember('channel', true, {chat: {id: CHAT_CHANNEL, title: 'E2E Channel'}}))
  } finally {
    e2e.container.users.getOrCreate = original
  }

  const after = await snapshot(e2e)
  expect(after.db).toEqual(before.db)
  expect(after.lnbits).toEqual(before.lnbits)
  expect(e2e.tg.calls.slice(telegramMark).filter(call => call.method === 'sendMessage')).toEqual([])
  expect(errorMessages()).toEqual(['Bot error'])
})

// --- Locales ---

test('update responses normalize Telegram language tags and preserve a usable fallback', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})

  const cases = [
    {languageCode: 'ru', stored: 'en', locale: 'ru', persisted: 'ru'},
    {languageCode: 'ru-RU', stored: 'en', locale: 'ru', persisted: 'ru-RU'},
    {languageCode: 'en', stored: 'ru', locale: 'en', persisted: 'en'},
    {languageCode: 'en-US', stored: 'ru', locale: 'en', persisted: 'en-US'},
    {languageCode: 'sr-Latn', stored: 'ru', locale: 'en', persisted: 'sr-Latn'},
    {languageCode: undefined, stored: 'ru-RU', locale: 'ru', persisted: 'ru-RU'},
    {languageCode: 'not_a_tag', stored: 'ru-RU', locale: 'ru', persisted: 'ru-RU'},
  ] as const

  for (const {languageCode, stored, locale, persisted} of cases) {
    e2e.tg.reset()
    e2e.logs.length = 0
    await e2e.container.users.update(USER_A, {languageCode: stored})
    await expectGroupError(
      groupText('/tip 21 @user_b', {
        from: {id: USER_A, username: 'user_a', language_code: languageCode},
      }),
      'insufficient_funds',
      locale,
    )
    expect((await e2e.container.users.findById(USER_A))?.languageCode).toBe(persisted)
  }
})

test('changing language_code in an update refreshes the user and the next error text', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  expect((await e2e.container.users.findById(USER_A))?.languageCode).toBe('en')

  await e2e.send(
    privateCommand('/wallet', {
      from: {id: USER_A, username: 'user_a', language_code: 'ru'},
    }),
  )
  expect((await e2e.container.users.findById(USER_A))?.languageCode).toBe('ru')

  e2e.tg.reset()
  e2e.logs.length = 0
  await expectGroupError(
    groupText('/tip 21 @user_b', {
      from: {id: USER_A, username: 'user_a', language_code: 'ru'},
    }),
    'insufficient_funds',
    'ru',
  )
})

test('job notifications normalize each stored language_code independently', async () => {
  await seedUser(e2e, {
    id: OWNER,
    username: 'chat_owner',
    firstName: 'Chat Owner',
    languageCode: 'sr-Latn',
  })
  await e2e.container.users.update(USER_A, {languageCode: 'ru-RU'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    status: 'active',
    paymentType: 'one_time',
    price: 1000,
  })
  await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: true,
    price: 1000,
    subscriptionType: 'one_time',
    kind: 'join',
  })

  await e2e.jobs.subscriptionPayments()

  const messages = e2e.tg.of('sendMessage')
  const subscriber = messages.find(call => Number(call.chat_id) === USER_A)
  const owner = messages.find(call => Number(call.chat_id) === OWNER)
  expect(String(subscriber?.text)).toMatch(/Доступ к сообществу/)
  expect(String(owner?.text)).toMatch(/Subscription type/)
  expect(String(owner?.text)).not.toMatch(/Тип подписки/)
  expectCleanUserText(String(subscriber?.text))
  expectCleanUserText(String(owner?.text))
})

// --- Wire format ---

test('error replies are sent with HTML parse mode and no raw keys', async () => {
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  await e2e.send(groupText('/tip 21 @user_b'))

  const errorCall = e2e.tg
    .of('sendMessage')
    .find(call => String(call.text).includes('Insufficient funds'))
  expect(errorCall?.parse_mode).toBe('HTML')
  expectCleanUserText(String(errorCall?.text))
})

test('every AppErrorCode has a real e2e path in this file', () => {
  const covered = new Set([
    'insufficient_funds',
    'invoice_already_paid',
    'invoice_generation_failed',
    'invoice_parsing',
    'nwc_timeout',
    'nwc_connection',
    'nwc_payment_failed',
    'nwc_no_answer',
    'no_recipient',
    'to_bot',
    'from_bot',
    'to_yourself',
    'user_has_no_wallet',
    'not_found',
    'unknown',
  ] satisfies AppErrorCode[])
  expect([...covered].sort()).toEqual([...ALL_CODES].sort())
})

// --- helpers ---

async function seedOwnerAndChat(): Promise<void> {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active'})
}

function expectPrivateErrorAndWallet(code: AppErrorCode, locale: Locale): void {
  const displayCode = code === 'not_found' ? 'unknown' : code
  const expected = expectedErrorText(displayCode, locale)
  const texts = e2e.tg.of('sendMessage').map(call => String(call.text))
  expect(texts).toContain(expected)
  // Private error path: error reply then wallet as a rich message.
  const isWallet = (text: string) =>
    text.includes('Balance:') || text.includes('NWC:') || /👛/.test(text)
  const walletHtmls = e2e.tg.of('sendRichMessage').map(call => {
    const richMessage = call.rich_message
    if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
    return String(Reflect.get(richMessage, 'html') ?? '')
  })
  expect(walletHtmls.some(isWallet)).toBe(true)
  expectCleanUserText(expected)
  expect(errorMessages().some(message => message === 'Bot error')).toBe(true)
}

async function expectGroupError(
  update: TestUpdate,
  code: AppErrorCode,
  locale: Locale,
): Promise<void> {
  const before = await snapshot(e2e)
  const displayCode = code === 'not_found' ? 'unknown' : code
  const expected = expectedErrorText(displayCode, locale)
  const sender = update.message?.from?.id
  if (sender === undefined) throw new Error('A group error scenario needs a sending user')

  await e2e.send(update)

  const after = await snapshot(e2e)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
  expect(after.db.subscriptionPayments).toEqual(before.db.subscriptionPayments)
  expect(after.db.pendingInvoices).toEqual(before.db.pendingInvoices)
  expect(errorTextTo(CHAT_GROUP)).toBe(expected)
  expectCleanUserText(expected)
  // Group failures are ephemeral: addressed to the sender alone, so nothing is deleted afterwards.
  expect(Number(errorCallTo(CHAT_GROUP).receiver_user_id)).toBe(sender)
  expect(e2e.tg.of('deleteMessages')).toEqual([])
  expect(errorMessages().some(message => message === 'Bot error')).toBe(true)
}

async function sendAndWaitForTempMessage(update: TestUpdate): Promise<void> {
  const previousDeletes = e2e.tg.of('deleteMessages').length
  await e2e.send(update)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (e2e.tg.of('deleteMessages').length > previousDeletes) return
    await Bun.sleep(5)
  }
  throw new Error('The temporary error message was never deleted')
}

async function expectMoneyUnchanged(before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  const after = await snapshot(e2e)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
}

function expectedErrorText(code: AppErrorCode, locale: Locale): string {
  return translate(errorTranslationKey[code], locale)
}

function expectedErrorPattern(code: AppErrorCode, locale: Locale): RegExp {
  const text = expectedErrorText(code, locale)
  const plain = text.replace(/<[^>]+>/g, '').trim()
  const fragment = plain.split('\n')[0]?.trim() ?? plain
  return new RegExp(escapeRegExp(fragment))
}

function errorTextTo(chatId: number): string {
  return String(errorCallTo(chatId).text)
}

function errorCallTo(chatId: number): Record<string, unknown> {
  const call = e2e.tg
    .of('sendMessage')
    .find(payload => Number(payload.chat_id) === chatId && String(payload.text).includes('⚠️'))
  if (!call) throw new Error(`No error sendMessage to ${chatId}`)
  return call
}

function expectCleanUserText(text: string): void {
  expect(text).not.toMatch(RAW_KEY)
  expect(text).not.toMatch(FLUENT_MARKS)
  expect(text.length).toBeGreaterThan(0)
}

function payButton(): string {
  const buttons = e2e.tg
    .of('sendMessage')
    .flatMap(call => {
      const markup = call.reply_markup as
        | {inline_keyboard?: {callback_data?: string}[][]}
        | undefined
      return markup?.inline_keyboard?.flat() ?? []
    })
    .map(button => button.callback_data)
    .filter((data): data is string => typeof data === 'string' && data.startsWith('pay:'))
  const button = buttons.at(-1)
  if (!button) throw new Error('Pay button not found')
  return button
}

function requiredPromptMessageId(): number {
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound invoice review message ID')
  return messageId
}

function stubNwcPayInvoice(impl: () => Promise<void> | void): void {
  const originalPay = NostrWallet.prototype.payInvoice
  const originalLookup = NostrWallet.prototype.lookupInvoice
  const originalBalance = NostrWallet.prototype.getBalance
  // Keep the real NWCClient from dialing relays during these mapping tests.
  NostrWallet.prototype.getBalance = async () => 0
  NostrWallet.prototype.lookupInvoice = async () =>
    ({preimage: null, fees_paid: 0}) as unknown as Awaited<ReturnType<NostrWallet['lookupInvoice']>>
  NostrWallet.prototype.payInvoice = async function payInvoiceStub() {
    await impl()
  }
  restorePayInvoice = () => {
    NostrWallet.prototype.payInvoice = originalPay
    NostrWallet.prototype.lookupInvoice = originalLookup
    NostrWallet.prototype.getBalance = originalBalance
  }
}

function credit(userId: number, sats: number): void {
  e2e.ln.state.credit(walletOf(userId).id, sats * 1000)
}

function walletOf(userId: number) {
  const user = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
