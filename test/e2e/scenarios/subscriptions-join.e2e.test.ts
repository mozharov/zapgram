import {afterEach, beforeEach, expect, test} from 'bun:test'
import {subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {SubscriptionPayment} from '@infra/db/types.js'
import {paySubscriptionRoute} from '@telegram/callback-data.js'
import {expectNoErrors, expectPayoutsExactly, expectWorldUnchanged} from '../asserts.js'
import {decodeMintedInvoice} from '../fakes/bolt11.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedChat, seedSubscription, seedUser} from '../fixtures/seed.js'
import {chatJoinRequest} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['subscriptions-join']

/**
 * The join half of paid subscriptions: one request either receives one real invoice, is approved
 * from an existing subscription, or is ignored because paid access is unavailable.
 *
 * A join invoice is deliberately still unpaid here. It must preserve the ledger and produce zero
 * payouts; charging, granting access and distributing the payment belong to the settle scenarios.
 * NWC-positive branches need the isolated NWC transport used by the dedicated NWC suite.
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
  telegramFailure?: boolean
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await seedApplicant('en')
})

afterEach(async () => {
  await e2e.dispose()
})

test('a fresh join request creates one linked one-time payment and no pay buttons', async () => {
  const {payment, telegram} = await issueJoinInvoice({
    walletMsat: (PRICE - 1) * 1000,
    text: /Access to private community "E2E paid chat"/,
  })

  expect(String(telegram.text)).toMatch(/Subscription type: <b>permanent access<\/b>/)
  expect(buttonsOf(telegram)).toEqual([])
  expect(payment.subscriptionType).toBe('one_time')
})

test('the invoice currently ignores the join request private-chat id', async () => {
  // Characterization of the open user_chat_id contract defect in docs/known-issues.md.
  const {telegram} = await issueJoinInvoice({
    userChatId: JOIN_USER_CHAT,
    text: /Access to private community/,
  })

  expect(telegram.chat_id).toBe(USER_A)
  expect(telegram.chat_id).not.toBe(JOIN_USER_CHAT)
})

test('an exact wallet balance offers the wallet button on a monthly channel invoice', async () => {
  const {payment, telegram} = await issueJoinInvoice({
    chatId: CHAT_CHANNEL,
    chatType: 'channel',
    locale: 'ru',
    paymentType: 'monthly',
    walletMsat: PRICE * 1000,
    text: /Доступ к закрытому сообществу "E2E paid chat"/,
  })

  const telegramText = String(telegram.text)
  expect(telegramText).toMatch(/Тип подписки: <b>доступ на месяц<\/b>/)
  expect(callbackDataOf(telegram)).toEqual([
    paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}),
  ])
  expect(buttonTextsOf(telegram)).toEqual(['Оплатить с баланса ZapGram'])
})

test('a wallet balance above the price still offers only the wallet button', async () => {
  const {payment, telegram} = await issueJoinInvoice({
    walletMsat: (PRICE + 1) * 1000,
    text: /Access to private community/,
  })

  expect(callbackDataOf(telegram)).toEqual([
    paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}),
  ])
  expect(callbackDataOf(telegram).some(data => data.endsWith(':nwc'))).toBe(false)
})

test('a rounded-up insufficient balance currently offers the wallet button', async () => {
  // Characterization of the open millisatoshi-rounding defect in docs/known-issues.md.
  const {payment, telegram} = await issueJoinInvoice({
    walletMsat: PRICE * 1000 - 500,
    text: /Access to private community/,
  })

  expect(callbackDataOf(telegram)).toEqual([
    paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}),
  ])
})

test('a current subscription approves the join request without issuing an invoice', async () => {
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

test('an expired subscription is currently approved before cleanup runs', async () => {
  // Characterization of the open expiry-check defect in docs/known-issues.md.
  await seedActiveChat({paymentType: 'monthly'})
  await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsAt: new Date(Date.now() - 60_000),
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

test('a Telegram delivery failure is logged without losing the payment record', async () => {
  e2e.tg.fail('sendMessage', {
    error_code: 400,
    description: 'Bad Request: user unavailable',
  })

  const {payment} = await issueJoinInvoice({
    text: /Access to private community/,
    telegramFailure: true,
  })

  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([payment])
  expect(errorMessages()).toEqual(['Error while sending message to user about chat join request'])
})

async function issueJoinInvoice(options: JoinInvoiceOptions) {
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
  await expectDelta(
    e2e,
    () => e2e.send(joinUpdate({chatType, locale, userChatId: options.userChatId})),
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {
          added: 1,
          match: rows => {
            expect(rows).toHaveLength(1)
            expect(rows[0]?.after).toMatchObject({
              userId: USER_A,
              chatId,
              price,
              subscriptionType: paymentType,
              kind: 'join',
              settledAt: null,
              settleAttempts: 0,
              payoutHash: null,
              feePayoutHash: null,
            })
          },
        },
      },
      lnbits: {payments: [{out: false, sats: price, times: 1}]},
      telegram: [{method: 'sendMessage', to: USER_A, text: options.text}],
    },
  )

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectNoPaidMasterPayouts(price)

  const payment = await onlySubscriptionPayment()
  expect(payment).toMatchObject({
    userId: USER_A,
    chatId,
    price,
    subscriptionType: paymentType,
    kind: 'join',
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
  })
  expect(payment.createdAt).toBeInstanceOf(Date)
  expect(decodeMintedInvoice(payment.paymentRequest)).toEqual({
    paymentHash: payment.paymentHash,
    amountMsat: price * 1000,
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
    amountMsat: price * 1000,
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
      body: {out: false, amount: price, unit: 'sat', expiry: DAY_SECONDS},
    },
  ])

  const telegram = e2e.tg.last('sendMessage')
  if (!telegram) throw new Error('Subscription invoice message was not attempted')
  expect(telegram).toMatchObject({
    chat_id: USER_A,
    parse_mode: 'HTML',
    link_preview_options: {is_disabled: true},
  })
  const telegramText = String(telegram.text)
  expect(telegramText).toMatch(pricePattern(price, locale))
  expect(telegramText).toContain(`<code>${payment.paymentRequest}</code>`)

  if (options.telegramFailure) {
    expect(errorMessages()).toEqual(['Error while sending message to user about chat join request'])
  } else {
    expectNoErrors(e2e.logs)
  }

  return {payment, telegram}
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
  return locale === 'ru'
    ? new RegExp(`Цена: <b>${groupedPrice} сат</b>`)
    : new RegExp(`Price: <b>${groupedPrice} sats</b>`)
}

function buttonsOf(payload: Record<string, unknown>): {callback_data?: string; text?: string}[] {
  const markup = payload.reply_markup as
    | {inline_keyboard?: {callback_data?: string; text?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat()
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
