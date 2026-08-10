import {afterEach, beforeEach, expect, setSystemTime, test} from 'bun:test'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {SubscriptionPayment} from '@infra/db/types.js'
import {payJoinBalanceRoute, payLightningRoute} from '@telegram/callback-data.js'
import {eq} from 'drizzle-orm'
import {expectNoErrors, expectPayoutsExactly, expectWorldUnchanged} from '../asserts.js'
import {decodeMintedInvoice} from '../fakes/bolt11.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedChat, seedSubscription, seedUser} from '../fixtures/seed.js'
import {chatJoinRequest, privateCallback} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['subscriptions-join']

/**
 * Join paid chats: chooser first (no invoice mint), then Lightning / balance / (optional) Bitcoin.
 * Invoice mint and settle still belong to Lightning path + settle scenarios.
 */

const PRICE = 1000
const MISSING_CHAT = -1001999999999
const JOIN_USER_CHAT = 100004
const DAY_SECONDS = 24 * 60 * 60
const HOUR_MS = 60 * 60 * 1000

type Locale = 'en' | 'ru'
type ChatType = 'supergroup' | 'channel'
type PaymentType = 'one_time' | 'monthly'

type JoinInvoiceOptions = {
  chatId?: number
  chatType?: ChatType
  locale?: Locale
  paymentType?: PaymentType
  price?: number
  walletMsat?: number
  userChatId?: number
  text: RegExp
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await seedApplicant('en')
})

afterEach(async () => {
  setSystemTime()
  await e2e.dispose()
})

test('a fresh join request sends a method chooser without minting an invoice', async () => {
  const {chooser} = await issueJoinChooser({
    walletMsat: (PRICE - 1) * 1000,
    text: /Access to private community "E2E paid chat"/,
  })

  expect(String(chooser.text)).toMatch(/Subscription type: <b>permanent access<\/b>/)
  expect(String(chooser.text)).toMatch(/Choose a payment method/)
  expect(String(chooser.text)).not.toMatch(/lnbc/)
  expect(callbackDataOf(chooser)).toEqual([payLightningRoute.build({chatId: CHAT_GROUP})])
  expect(buttonTextsOf(chooser)).toEqual(['⚡ Lightning'])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expect(await e2e.db.select().from(subscriptionIntentsTable)).toEqual([])
})

test('choosing Lightning mints one linked one-time invoice with no balance button', async () => {
  const {payment, telegram} = await issueJoinInvoice({
    walletMsat: (PRICE - 1) * 1000,
    text: /Access to private community "E2E paid chat"/,
  })

  expect(String(telegram.text)).toMatch(/Subscription type: <b>permanent access<\/b>/)
  expect(String(telegram.text)).toContain(`<code>${payment.paymentRequest}</code>`)
  expect(buttonsOf(telegram)).toEqual([])
  expect(payment.subscriptionType).toBe('one_time')
})

test('the chooser is sent to the join request private-chat id', async () => {
  const {chooser} = await issueJoinChooser({
    userChatId: JOIN_USER_CHAT,
    text: /Access to private community/,
  })

  expect(chooser.chat_id).toBe(JOIN_USER_CHAT)
  expect(chooser.chat_id).not.toBe(USER_A)
})

test('an exact wallet balance offers the ZapGram button on chooser and Lightning invoice', async () => {
  const {telegram, chooser} = await issueJoinInvoice({
    chatId: CHAT_CHANNEL,
    chatType: 'channel',
    locale: 'ru',
    paymentType: 'monthly',
    walletMsat: PRICE * 1000,
    text: /Доступ к закрытому сообществу "E2E paid chat"/,
  })

  expect(callbackDataOf(chooser)).toEqual([
    payLightningRoute.build({chatId: CHAT_CHANNEL}),
    payJoinBalanceRoute.build({chatId: CHAT_CHANNEL, from: 'wallet'}),
  ])
  // Method row, then wallet on its own row (no NWC without funds).
  expect(buttonTextRowsOf(chooser)).toEqual([['⚡ Лайтнинг'], ['💰 С баланса ZapGram']])

  const telegramText = String(telegram.text)
  expect(telegramText).toMatch(/Тип подписки: <b>доступ на месяц<\/b>/)
  expect(callbackDataOf(telegram)).toEqual([
    payJoinBalanceRoute.build({chatId: CHAT_CHANNEL, from: 'wallet'}),
  ])
  expect(buttonTextsOf(telegram)).toEqual(['💰 С баланса ZapGram'])
})

test('a wallet balance above the price still offers only the ZapGram button', async () => {
  const {telegram} = await issueJoinInvoice({
    walletMsat: (PRICE + 1) * 1000,
    text: /Access to private community/,
  })

  expect(callbackDataOf(telegram)).toEqual([
    payJoinBalanceRoute.build({chatId: CHAT_GROUP, from: 'wallet'}),
  ])
  expect(buttonTextsOf(telegram)).toEqual(['💰 Pay with ZapGram balance'])
})

test('a half-satoshi short balance does not offer the balance button', async () => {
  const {telegram, chooser} = await issueJoinInvoice({
    walletMsat: PRICE * 1000 - 500,
    text: /Access to private community/,
  })

  expect(callbackDataOf(chooser)).toEqual([payLightningRoute.build({chatId: CHAT_GROUP})])
  expect(callbackDataOf(telegram)).toEqual([])
  expect(buttonsOf(telegram)).toEqual([])
})

test('a current subscription approves the join request without a chooser', async () => {
  await seedActiveChat({paymentType: 'monthly'})
  await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsAt: new Date(Date.now() + HOUR_MS),
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  expect(e2e.tg.last('approveChatJoinRequest')).toEqual({
    chat_id: CHAT_GROUP,
    user_id: USER_A,
    parse_mode: 'HTML',
  })
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('an expired subscription requires choosing Lightning before an invoice exists', async () => {
  await seedActiveChat({paymentType: 'monthly'})
  await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsAt: new Date(Date.now() - 60_000),
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
  })
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])

  const joinMessage = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('en'),
          messageId: Number(joinMessage?.message_id ?? 1),
        }),
      ),
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {added: 1},
      },
      lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
      telegram: [
        {method: 'editMessageText', text: /Access to private community/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  expect(e2e.tg.of('approveChatJoinRequest')).toHaveLength(0)
  const [payment] = await e2e.db.select().from(subscriptionPaymentsTable)
  expect(payment).toMatchObject({
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    kind: 'join',
    subscriptionType: 'monthly',
    settledAt: null,
  })
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts(PRICE)
  expectNoErrors(e2e.logs)
})

for (const status of ['inactive', 'no_access'] as const) {
  const article = status === 'inactive' ? 'an' : 'a'
  const testName = `a join request for ${article} ${status} chat leaves the world unchanged`
  test(testName, async () => {
    await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status})
    const before = await snapshot(e2e)

    await expectDelta(e2e, () => e2e.send(joinUpdate()), {})

    const after = await snapshot(e2e)
    expectWorldUnchanged(before, after)
    expectLedgerBalanced(before, after)
    expectNoPaidMasterPayouts()
    expectNoErrors(e2e.logs)
  })
}

test('a join request for an unknown chat leaves the whole world unchanged', async () => {
  const before = await snapshot(e2e)

  await expectDelta(
    e2e,
    () => e2e.send(joinUpdate({chat: {id: MISSING_CHAT, title: 'Unknown group'}})),
    {},
  )

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('a Telegram delivery failure on the chooser leaves no payment record', async () => {
  await seedActiveChat()
  e2e.tg.fail('sendMessage', {
    error_code: 400,
    description: 'Bad Request: user unavailable',
  })

  // fail() still records the attempted call; delta must allow the failed sendMessage.
  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'sendMessage', to: USER_A}],
  })

  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expect(await e2e.db.select().from(subscriptionIntentsTable)).toEqual([])
  expect(errorMessages()).toEqual(['Error while sending message to user about chat join request'])
})

test('an LNbits mint failure on Lightning leaves no payment after the chooser', async () => {
  await seedActiveChat()
  await e2e.send(joinUpdate({userChatId: JOIN_USER_CHAT}))
  const chooser = e2e.tg.last('sendMessage')
  e2e.ln.state.failNext(
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: body => asRecord(body)?.out === false,
    },
    {status: 520, body: {status: 'failed', detail: 'backend unavailable'}},
  )

  const before = await snapshot(e2e)
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('en'),
          messageId: Number(chooser?.message_id ?? 1),
        }),
      ),
    {
      db: {subscriptionIntents: {added: 1}},
      // Error handler DMs the failure and re-renders the wallet.
      telegram: [
        {
          method: 'sendMessage',
          to: USER_A,
          text: /Failed to create the Lightning invoice/,
        },
        {method: 'sendMessage', to: USER_A, text: /Wallet/},
      ],
    },
  )

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  const intents = await e2e.db.select().from(subscriptionIntentsTable)
  expect(intents).toHaveLength(1)
  expect(intents[0]).toMatchObject({
    userId: USER_A,
    chatId: CHAT_GROUP,
    kind: 'join',
    status: 'open',
    attemptReservationId: null,
    winnerAttemptId: null,
  })
  expectNoPaidMasterPayouts()
  expect(errorMessages()).toEqual(['Bot error'])
})

test('repeated Lightning picks reuse one invoice and report remaining time', async () => {
  const {payment, telegram: firstInvoice} = await issueJoinInvoice({
    text: /valid for another.*hour/,
  })

  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length
  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
  })
  const secondChooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('en'),
          messageId: Number(secondChooser?.message_id ?? 1),
        }),
      ),
    {
      telegram: [
        {
          method: 'editMessageText',
          text: new RegExp(escapeRegex(payment.paymentRequest)),
        },
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  const restored = e2e.tg.last('editMessageText')
  if (!restored) throw new Error('Repeated Lightning invoice was not edited in place')
  expect(String(restored.text)).toContain(payment.paymentRequest)
  expect(String(firstInvoice.text)).toContain(payment.paymentRequest)
  expect(invoiceMintRequestsSince(requestMark)).toEqual([])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([payment])
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('parallel Lightning picks converge on one current attempt and one BOLT11', async () => {
  const {chooser} = await issueJoinChooser({})
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length
  const messageId = Number(chooser.message_id ?? 1)
  const tgMark = e2e.tg.calls.length

  await Promise.all([
    e2e.send(
      privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
        from: applicantFrom('en'),
        messageId,
      }),
    ),
    e2e.send(
      privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
        from: applicantFrom('en'),
        messageId,
      }),
    ),
  ])

  const [payment] = await e2e.db.select().from(subscriptionPaymentsTable)
  if (!payment) throw new Error('Parallel join invoice was not stored')
  expect(payment.isCurrent).toBe(true)
  expect(invoiceMintRequestsSince(requestMark)).toHaveLength(1)
  // Race: edits/answers may interleave; both must still show the same BOLT11.
  const edits = e2e.tg.calls
    .slice(tgMark)
    .filter(call => call.method === 'editMessageText')
    .map(call => call.payload)
  expect(edits).toHaveLength(2)
  expect(edits.every(message => String(message.text).includes(payment.paymentRequest))).toBe(true)
  expect(e2e.tg.calls.slice(tgMark).filter(call => call.method === 'answerCallbackQuery')).toHaveLength(
    2,
  )
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('an invoice with exactly one hour remaining is reused and reports one hour', async () => {
  const {payment} = await issueJoinInvoice({text: /valid for another/})
  const now = currentWholeSecond()
  setSystemTime(now)
  await setAttemptExpiry(payment.id, new Date(now.getTime() + HOUR_MS))
  const requestMark = e2e.ln.requests.length

  await e2e.send(joinUpdate())
  const chooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('en'),
          messageId: Number(chooser?.message_id ?? 1),
        }),
      ),
    {
      telegram: [
        {method: 'editMessageText', text: /valid for another <b>1 hour<\/b>/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  expect(invoiceMintRequestsSince(requestMark)).toEqual([])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toHaveLength(1)
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('an invoice below one hour is replaced without deleting the previous attempt', async () => {
  const {payment: previous} = await issueJoinInvoice({text: /valid for another/})
  const now = currentWholeSecond()
  setSystemTime(now)
  await setAttemptExpiry(previous.id, new Date(now.getTime() + HOUR_MS - 1000))
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await e2e.send(joinUpdate())
  const chooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('en'),
          messageId: Number(chooser?.message_id ?? 1),
        }),
      ),
    {
      db: {
        subscriptionPayments: {added: 1, changed: 1},
      },
      lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
      telegram: [
        {method: 'editMessageText', text: /valid for another/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  const attempts = await e2e.db.select().from(subscriptionPaymentsTable)
  expect(attempts).toHaveLength(2)
  expect(attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({id: previous.id, isCurrent: false, attemptStatus: 'pending'}),
      expect.objectContaining({isCurrent: true, attemptStatus: 'pending'}),
    ]),
  )
  expect(attempts.filter(attempt => attempt.isCurrent)).toHaveLength(1)
  expect(invoiceMintRequestsSince(requestMark)).toHaveLength(1)
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts()
  expectNoErrors(e2e.logs)
})

test('a restart after mint and failed Lightning edit reuses the persisted attempt', async () => {
  await e2e.dispose()
  e2e = await createE2E({mode: 'file'})
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await seedApplicant('ru')
  await seedActiveChat()

  await e2e.send(joinUpdate({locale: 'ru'}))
  const chooser = e2e.tg.last('sendMessage')
  e2e.tg.fail('editMessageText', {
    error_code: 500,
    description: 'Internal Server Error: connection closed after mint',
  })

  await e2e.send(
    privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
      from: applicantFrom('ru'),
      messageId: Number(chooser?.message_id ?? 1),
    }),
  )
  const [persisted] = await e2e.db.select().from(subscriptionPaymentsTable)
  if (!persisted) throw new Error('Minted attempt was not persisted before Telegram edit')
  const requestMark = e2e.ln.requests.length
  await e2e.restart()

  await e2e.send(joinUpdate({locale: 'ru'}))
  const secondChooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: applicantFrom('ru'),
          messageId: Number(secondChooser?.message_id ?? 1),
        }),
      ),
    {
      telegram: [
        {
          method: 'editMessageText',
          text: new RegExp(escapeRegex(persisted.paymentRequest)),
        },
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Счёт действителен ещё/)
  expect(invoiceMintRequestsSince(requestMark)).toEqual([])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([persisted])
  expect(await e2e.db.select().from(subscriptionIntentsTable)).toHaveLength(1)
  expectNoPaidMasterPayouts()
})

function applicantFrom(locale: Locale = 'en') {
  return {
    id: USER_A,
    username: 'applicant',
    first_name: 'Applicant',
    language_code: locale,
  }
}

async function issueJoinChooser(options: {
  chatId?: number
  chatType?: ChatType
  locale?: Locale
  paymentType?: PaymentType
  price?: number
  walletMsat?: number
  userChatId?: number
  text?: RegExp
}) {
  const chatId = options.chatId ?? CHAT_GROUP
  const chatType = options.chatType ?? 'supergroup'
  const locale = options.locale ?? 'en'
  const paymentType = options.paymentType ?? 'one_time'
  const price = options.price ?? PRICE
  await seedApplicant(locale)
  await seedActiveChat({id: chatId, type: chatType, paymentType, price})
  creditApplicant(options.walletMsat ?? 0)

  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length
  const invoiceChatId = options.userChatId ?? USER_A
  const chooserText =
    options.text ??
    (locale === 'ru' ? /Выбери способ оплаты/ : /Choose a payment method/)
  await expectDelta(
    e2e,
    () => e2e.send(joinUpdate({chatType, locale, userChatId: options.userChatId})),
    {
      telegram: [{method: 'sendMessage', to: invoiceChatId, text: chooserText}],
    },
  )

  expect(invoiceMintRequestsSince(requestMark)).toEqual([])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expectLedgerBalanced(before, await snapshot(e2e))
  expectNoPaidMasterPayouts(price)
  expectNoErrors(e2e.logs)

  const chooser = e2e.tg.last('sendMessage')
  if (!chooser) throw new Error('Join method chooser was not sent')
  expect(chooser).toMatchObject({
    chat_id: invoiceChatId,
    parse_mode: 'HTML',
    link_preview_options: {is_disabled: true},
  })
  expect(String(chooser.text)).toMatch(pricePattern(price, locale))
  return {chooser, chatId, locale, price, paymentType}
}

async function issueJoinInvoice(options: JoinInvoiceOptions) {
  const setup = await issueJoinChooser({
    ...options,
    // Chooser never includes the BOLT11; match only method-picker copy here.
    text: options.locale === 'ru' ? /Выбери способ оплаты/ : /Choose a payment method/,
  })
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: setup.chatId}), {
          from: applicantFrom(setup.locale),
          messageId: Number(setup.chooser.message_id ?? 1),
        }),
      ),
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {
          added: 1,
          match: rows => {
            expect(rows).toHaveLength(1)
            expect(rows[0]?.after).toMatchObject({
              userId: USER_A,
              chatId: setup.chatId,
              price: setup.price,
              subscriptionType: setup.paymentType,
              kind: 'join',
              settledAt: null,
              settleAttempts: 0,
              payoutHash: null,
              feePayoutHash: null,
            })
          },
        },
      },
      lnbits: {payments: [{out: false, sats: setup.price, times: 1}]},
      telegram: [
        {method: 'editMessageText', text: options.text},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectNoPaidMasterPayouts(setup.price)

  const payment = await onlySubscriptionPayment()
  expect(payment).toMatchObject({
    userId: USER_A,
    chatId: setup.chatId,
    price: setup.price,
    subscriptionType: setup.paymentType,
    kind: 'join',
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
  })
  expect(payment.createdAt).toBeInstanceOf(Date)
  expect(decodeMintedInvoice(payment.paymentRequest)).toEqual({
    paymentHash: payment.paymentHash,
    amountMsat: setup.price * 1000,
    description: '',
  })

  const masterWallet = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!masterWallet) throw new Error('Fake LNbits master wallet not found')
  const incoming = e2e.ln.state.payments.filter(
    candidate =>
      !candidate.out &&
      candidate.bolt11 === payment.paymentRequest &&
      candidate.paymentHash === payment.paymentHash,
  )
  expect(incoming).toHaveLength(1)
  expect(incoming[0]).toMatchObject({
    walletId: masterWallet.id,
    amountMsat: setup.price * 1000,
    out: false,
    paid: false,
    feeMsat: 0,
    memo: '',
  })
  const incomingInvoice = incoming[0]
  if (!incomingInvoice) throw new Error('Linked master-wallet invoice was not found')
  const remainingMs = incomingInvoice.expiresAt.getTime() - Date.now()
  expect(remainingMs).toBeGreaterThan(23 * HOUR_MS)
  expect(remainingMs).toBeLessThan(25 * HOUR_MS)

  const invoiceRequests = e2e.ln.requests
    .slice(requestMark)
    .filter(request => request.method === 'POST' && request.path === '/api/v1/payments')
  expect(invoiceRequests).toEqual([
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: {
        out: false,
        amount: setup.price,
        unit: 'sat',
        expiry: DAY_SECONDS,
        webhook: `https://test.local/lnbits/webhook/${e2e.container.config.BOT_WEBHOOK_SECRET}`,
      },
    },
  ])

  const telegram = e2e.tg.last('editMessageText')
  if (!telegram) throw new Error('Lightning invoice edit was not attempted')
  const telegramText = String(telegram.text)
  expect(telegramText).toMatch(pricePattern(setup.price, setup.locale))
  expect(telegramText).toContain(`<code>${payment.paymentRequest}</code>`)
  expectNoErrors(e2e.logs)

  return {payment, telegram, chooser: setup.chooser}
}

function seedApplicant(locale: Locale) {
  return seedUser(e2e, {
    id: USER_A,
    username: 'applicant',
    firstName: 'Applicant',
    languageCode: locale,
  })
}

function seedActiveChat(
  overrides: {id?: number; type?: ChatType; paymentType?: PaymentType; price?: number} = {},
) {
  return seedChat(e2e, {
    id: overrides.id ?? CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    type: overrides.type ?? 'supergroup',
    status: 'active',
    paymentType: overrides.paymentType ?? 'one_time',
    price: overrides.price ?? PRICE,
  })
}

function joinUpdate(
  options: {
    chatType?: ChatType
    locale?: Locale
    chat?: Record<string, unknown>
    userChatId?: number
  } = {},
) {
  const update = chatJoinRequest(options.chatType ?? 'supergroup', {
    from: {
      id: USER_A,
      username: 'applicant',
      first_name: 'Applicant',
      language_code: options.locale ?? 'en',
    },
    chat: options.chat,
  })
  if (options.userChatId !== undefined) {
    const request = update.chat_join_request
    if (!request) throw new Error('chatJoinRequest fixture did not create a join request')
    request.user_chat_id = options.userChatId
  }
  return update
}

function creditApplicant(msats: number): void {
  if (msats === 0) return
  const user = e2e.ln.state.getUserByUsername(String(USER_A))
  const wallet = user ? e2e.ln.state.walletsOfUser(user.id)[0] : undefined
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${USER_A}`)
  e2e.ln.state.credit(wallet.id, msats)
}

async function onlySubscriptionPayment(): Promise<SubscriptionPayment> {
  const payments = await e2e.db.select().from(subscriptionPaymentsTable)
  expect(payments).toHaveLength(1)
  const payment = payments[0]
  if (!payment) throw new Error('Subscription payment was not found')
  return payment
}

function expectNoPaidMasterPayouts(price = PRICE): void {
  expectPayoutsExactly(e2e.ln, {toWallet: 'master wallet', sats: price, times: 0})
}

function callbackDataOf(payload: Record<string, unknown>): string[] {
  return buttonsOf(payload).flatMap(button => button.callback_data ?? [])
}

function buttonTextsOf(payload: Record<string, unknown>): string[] {
  return buttonsOf(payload).flatMap(button => button.text ?? [])
}

function pricePattern(price: number, locale: Locale): RegExp {
  const groupedPrice = String(price).replace(/\B(?=(\d{3})+(?!\d))/g, '\\D?')
  // Optional fiat suffix: default fake rate 100_000 → 1000 sats (~$1.00)
  const usd = '(?: \\(~\\$[^)]+\\))?'
  return locale === 'ru'
    ? new RegExp(`Цена: <b>${groupedPrice} сат${usd}</b>`)
    : new RegExp(`Price: <b>${groupedPrice} sats${usd}</b>`)
}

function buttonsOf(payload: Record<string, unknown>): {callback_data?: string; text?: string}[] {
  const markup = payload.reply_markup as
    | {inline_keyboard?: {callback_data?: string; text?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat()
}

function buttonTextRowsOf(payload: Record<string, unknown>): string[][] {
  const markup = payload.reply_markup as
    | {inline_keyboard?: {callback_data?: string; text?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).map(row => row.flatMap(button => button.text ?? []))
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

async function setAttemptExpiry(paymentId: string, expiresAt: Date): Promise<void> {
  await e2e.db
    .update(subscriptionPaymentsTable)
    .set({expiresAt})
    .where(eq(subscriptionPaymentsTable.id, paymentId))
}

function invoiceMintRequestsSince(mark: number) {
  return e2e.ln.requests
    .slice(mark)
    .filter(request => request.method === 'POST' && request.path === '/api/v1/payments')
    .filter(request => request.body && Reflect.get(request.body, 'out') === false)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function currentWholeSecond(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000)
}
