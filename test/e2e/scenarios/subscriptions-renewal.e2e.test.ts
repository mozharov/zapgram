import {afterEach, beforeEach, expect, setSystemTime, test} from 'bun:test'
import {ONE_MONTH_IN_MS} from '@core/subscriptions/policy.js'
import type {Subscription, SubscriptionPayment} from '@infra/db/types.js'
import {paySubscriptionRoute} from '@telegram/callback-data.js'
import {translate} from '@telegram/i18n/i18n.js'
import {expectNoErrors, expectPayoutsExactly, expectWorldUnchanged} from '../asserts.js'
import {decodeMintedInvoice} from '../fakes/bolt11.js'
import type {FakeWallet} from '../fakes/lnbits-state.js'
import {CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {
  seedChat,
  seedExpiringSubscription,
  seedSubscription,
  seedSubscriptionPayment,
  seedUser,
} from '../fixtures/seed.js'
import {privatePhotoCaptionCallback} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['subscriptions-renewal']

/**
 * Monthly subscription lifecycle after initial access: charge or invoice an expiring subscriber,
 * settle a paid renewal through the common payout path, then remove access after expiry.
 */

const PRICE = 1000
const CHANGED_CHAT_PRICE = 2000
const FEE = 50
const OWNER_PAYOUT = PRICE - FEE
const EXPIRING_FETCH_CAP = 50
const FAILURE = {status: 503, body: {detail: 'Injected renewal failure'}}
const CHANGED_PRICE_TEST = [
  'a manual renewal invoice uses the saved subscription price',
  'when the chat price has changed',
].join(' ')

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({env: {LOG_LEVEL: 'info'}})
  await seedUser(e2e, {
    id: OWNER,
    username: 'chat_owner',
    firstName: 'Chat Owner',
    languageCode: 'en',
  })
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'ru',
  })
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    status: 'active',
    paymentType: 'monthly',
    price: PRICE,
  })
})

afterEach(async () => {
  setSystemTime()
  await e2e.dispose()
})

test('an expiring subscription auto-renews from the internal balance exactly once', async () => {
  const subscription = await seedExpiringSubscription(e2e, {price: PRICE})
  creditUser(USER_A, PRICE)
  const requestMark = e2e.ln.requests.length
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectRenewedSubscription(rows, subscription),
      },
    },
    lnbits: {
      balances: {
        [walletForUser(USER_A).name]: -PRICE,
        [walletForUser(OWNER).name]: OWNER_PAYOUT,
        [feeWallet().name]: FEE,
      },
      payments: successfulRenewalEvents(PRICE),
    },
    telegram: successfulRenewalTelegramCalls(),
  })

  const afterFirstRun = await snapshot(e2e)
  expectLedgerBalanced(before, afterFirstRun)
  expect((await requiredSubscription()).endsAt).toEqual(extendedEndsAt(subscription))
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([])
  expectRenewalPayouts(1)
  expectExactApproval()
  const subscriberMessage = e2e.tg.of('sendMessage')[0]
  const ownerMessage = e2e.tg.of('sendMessage')[1]
  expect(subscriberMessage?.text).toBe(
    translate('subscription-renewal.renewed', 'ru', {
      title: 'E2E paid chat',
      expiryDate: extendedEndsAt(subscription),
      price: PRICE,
    }),
  )
  expect(String(subscriberMessage?.text)).not.toContain('Доступ к сообществу')
  expect(String(ownerMessage?.text)).toContain('Subscription type: <b>monthly</b>')
  expectPaymentRequestOrder(requestMark, PRICE)
  expectNoErrors(e2e.logs)

  const secondRequestMark = e2e.ln.requests.length
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {})
  const afterSecondRun = await snapshot(e2e)
  expectWorldUnchanged(afterFirstRun, afterSecondRun)
  expectLedgerBalanced(afterFirstRun, afterSecondRun)
  expect(e2e.ln.requests).toHaveLength(secondRequestMark)
  expectRenewalPayouts(1)
  expectNoErrors(e2e.logs)
})

test('an insufficient balance reuses one renewal payment for the manual reminder', async () => {
  const subscription = await seedExpiringSubscription(e2e, {price: PRICE})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectNotificationMarked(rows, subscription),
      },
      subscriptionIntents: {added: 1},
      subscriptionPayments: {
        added: 1,
        match: rows => {
          expect(rows).toHaveLength(1)
          expectRenewalPayment(rows[0]?.after, PRICE)
        },
      },
    },
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [{method: 'sendPhoto', to: USER_A, text: /истекает через 24 часа/}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  const payments = await e2e.db.query.subscriptionPaymentsTable.findMany()
  expect(payments).toHaveLength(1)
  const [payment] = payments
  if (!payment) throw new Error('Renewal payment was not found')
  expect(decodeMintedInvoice(payment.paymentRequest)?.amountMsat).toBe(PRICE * 1000)
  const photo = requiredPhoto()
  expect(String(photo.caption)).toContain(payment.paymentRequest)
  expect(callbackDataOf(photo)).toEqual([
    paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}),
  ])
  const masterId = masterWallet().id
  const masterInvoices = e2e.ln.state.payments.filter(candidate => {
    return (
      !candidate.out && candidate.walletId === masterId && candidate.amountMsat === PRICE * 1000
    )
  })
  expect(masterInvoices).toHaveLength(1)
  expect(masterInvoices[0]?.paymentHash).toBe(payment.paymentHash)
  expect(errorMessages()).toEqual([
    'POST /api/v1/payments: HTTP error',
    'Error paying invoice',
    'Error paying invoice from balance',
  ])
  expectRenewalPayouts(0)

  const requestMark = e2e.ln.requests.length
  const beforeSecondRun = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {})
  expectWorldUnchanged(beforeSecondRun, await snapshot(e2e))
  expect(e2e.ln.requests).toHaveLength(requestMark)
})

test('an existing renewal payment is handed off without another charge or reminder', async () => {
  const subscription = await seedExpiringSubscription(e2e, {price: PRICE})
  const payment = await seedSubscriptionPayment(e2e, {
    paid: false,
    price: PRICE,
    subscriptionType: 'monthly',
    kind: 'renewal',
  })
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length
  const logMark = e2e.logs.length
  const expiringFetches = capExpiringSubscriptionFetch()

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  expect(await requiredPayment(payment.id)).toEqual(payment)
  expect(await requiredSubscription()).toEqual(subscription)
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect(expiringFetches()).toBeLessThanOrEqual(EXPIRING_FETCH_CAP)
  expect(e2e.tg.calls).toEqual([])
  expectRenewalPayouts(0)
  expectNoErrors(e2e.logs)
  expect(infoMessages(logMark)).toContain(
    'A subscription payment is already in flight; leaving this renewal to the settle cron.',
  )
  expect(infoMessages(logMark)).toContain(
    'Renewal handed off to the subscription payment settle path.',
  )
  expect(infoMessages(logMark)).toContain(
    'Finished processing 1 subscriptions expiring within 24 hours.',
  )
})

function capExpiringSubscriptionFetch(): () => number {
  const repository = e2e.container.subscriptions
  const original = repository.getExpiringWithin.bind(repository)
  let calls = 0
  repository.getExpiringWithin = async (...args) => {
    calls++
    if (calls > EXPIRING_FETCH_CAP) throw new Error('Expiring subscription fetch cap exceeded')
    return original(...args)
  }
  return () => calls
}

test('disabled auto-renewal creates one exact manual invoice and one wallet button', async () => {
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    autoRenew: false,
  })
  const requestMark = e2e.ln.requests.length

  const {payment, photo} = await issueManualRenewal(subscription, PRICE)

  expect(decodeMintedInvoice(payment.paymentRequest)?.amountMsat).toBe(PRICE * 1000)
  expect(String(photo.caption)).toMatch(/сумму 1\D?000 сат/)
  expect(photo.show_caption_above_media).toBe('true')
  expect(String(photo.photo)).toMatch(/^attach:\/\//)
  const attachment = photo[String(photo.photo).slice('attach://'.length)]
  expect(attachment).toBeInstanceOf(File)
  if (!(attachment instanceof File)) throw new Error('Renewal QR attachment was not a File')
  const signature = new Uint8Array(await attachment.arrayBuffer()).slice(0, 8)
  expect([...signature]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(callbackDataOf(photo)).toEqual([
    paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}),
  ])
  expect(buttonTextsOf(photo)).toEqual(['Оплатить с баланса ZapGram'])
  const requests = paymentRequestsSince(requestMark)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.body).toMatchObject({
    out: false,
    amount: PRICE,
    unit: 'sat',
    expiry: 24 * 60 * 60,
  })
})

test('paying a manual renewal invoice reaches the common settlement path', async () => {
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    autoRenew: false,
  })
  const {payment, photo} = await issueManualRenewal(subscription, PRICE)
  creditUser(USER_A, PRICE)
  const beforePayment = await snapshot(e2e)

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privatePhotoCaptionCallback(callbackDataOf(photo)[0] ?? '', {
          from: {language_code: 'ru'},
        }),
      ),
    {
      lnbits: {
        balances: {[walletForUser(USER_A).name]: -PRICE, [masterWallet().name]: PRICE},
        payments: [
          {out: false, sats: PRICE, times: 1},
          {out: true, sats: PRICE, times: 1},
        ],
      },
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Оплата прошла/},
      ],
    },
  )

  const afterPayment = await snapshot(e2e)
  expectLedgerBalanced(beforePayment, afterPayment)
  expect(await requiredPayment(payment.id)).toEqual(payment)
  const subscriptionBeforeSettle = await requiredSubscription()

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectRenewedSubscription(rows, subscriptionBeforeSettle),
      },
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: payment.id}),
      },
    },
    lnbits: {
      balances: {
        [masterWallet().name]: -PRICE,
        [walletForUser(OWNER).name]: OWNER_PAYOUT,
        [feeWallet().name]: FEE,
      },
      payments: payoutEvents(),
    },
    telegram: successfulRenewalTelegramCalls(),
  })

  const afterSettle = await snapshot(e2e)
  expectLedgerBalanced(afterPayment, afterSettle)
  expect((await requiredSubscription()).endsAt).toEqual(extendedEndsAt(subscription))
  expect((await requiredSubscription()).notificationSent).toBe(false)
  expect(await e2e.container.payments.findById(payment.id)).toBeUndefined()
  expectRenewalPayouts(1)
  expectExactApproval()
  const renewedMessage = e2e.tg
    .of('sendMessage')
    .find(message => String(message.text).includes('продлена'))
  expect(String(renewedMessage?.text)).not.toContain('Доступ к сообществу')
  expectNoErrors(e2e.logs)
})

// docs/known-issues.md — "Manual renewal invoices use the current chat price instead of the subscription price"
test(CHANGED_PRICE_TEST, async () => {
  await e2e.container.chats.update(CHAT_GROUP, {price: CHANGED_CHAT_PRICE})
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    autoRenew: false,
  })

  const {payment, photo} = await issueManualRenewal(subscription, PRICE)

  expect(payment.price).toBe(PRICE)
  const decoded = decodeMintedInvoice(payment.paymentRequest)
  expect(decoded?.amountMsat).toBe(PRICE * 1000)
  expect(String(photo.caption)).toContain(payment.paymentRequest)
  expect(String(photo.caption)).toMatch(/сумму 1\D?000 сат/)
  expect(String(photo.caption)).not.toMatch(/сумму 2\D?000 сат/)
  expectRenewalPayouts(0)
})

// docs/known-issues.md — "A failed renewal reminder is marked as sent"
test('a manual invoice mint failure is retried and not marked notified', async () => {
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    autoRenew: false,
  })
  e2e.ln.state.failNext(
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: body => asRecord(body)?.out === false,
    },
    FAILURE,
  )
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {})

  const afterFail = await snapshot(e2e)
  expectLedgerBalanced(before, afterFail)
  expectWorldUnchanged(before, afterFail)
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([])
  expect(e2e.tg.calls).toEqual([])
  expect(errorMessages()).toEqual(['Error in createAndSendRenewalInvoice'])
  expect(await requiredSubscription()).toMatchObject({
    id: subscription.id,
    notificationSent: false,
  })

  // failNext is one-shot; the next tick mints and delivers, then marks notified.
  // Prior error logs stay on the harness — only assert the successful retry delta.
  const errorMark = errorMessages().length
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectNotificationMarked(rows, subscription),
      },
      subscriptionIntents: {added: 1},
      subscriptionPayments: {
        added: 1,
        match: rows => expectRenewalPayment(rows[0]?.after, PRICE),
      },
    },
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [{method: 'sendPhoto', to: USER_A, text: /истекает через 24 часа/}],
  })
  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect(errorMessages()).toHaveLength(errorMark)
  const payment = await onlySubscriptionPayment()
  expect(decodeMintedInvoice(payment.paymentRequest)?.amountMsat).toBe(PRICE * 1000)
  expect(String(requiredPhoto().caption)).toContain(payment.paymentRequest)
})

// docs/known-issues.md — "A failed renewal reminder is marked as sent"
test('a rejected manual invoice photo is retried and not marked notified', async () => {
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    autoRenew: false,
  })
  e2e.tg.fail('sendPhoto', {error_code: 400, description: 'Injected delivery failure'})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptionIntents: {added: 1},
      subscriptionPayments: {
        added: 1,
        match: rows => expectRenewalPayment(rows[0]?.after, PRICE),
      },
    },
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [{method: 'sendPhoto', to: USER_A, text: /истекает через 24 часа/}],
  })

  const afterFail = await snapshot(e2e)
  expectLedgerBalanced(before, afterFail)
  expect(errorMessages()).toEqual([
    'Failed to send Telegram photo',
    'Renewal reminder photo was not delivered',
  ])
  const payment = await onlySubscriptionPayment()
  expect(String(requiredPhoto().caption)).toContain(payment.paymentRequest)
  expect(await requiredSubscription()).toMatchObject({
    id: subscription.id,
    notificationSent: false,
  })

  // One-shot fail is spent; retry reuses the same payment and delivers the photo.
  const requestMark = e2e.ln.requests.length
  const errorMark = errorMessages().length
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectNotificationMarked(rows, subscription),
      },
    },
    telegram: [{method: 'sendPhoto', to: USER_A, text: /истекает через 24 часа/}],
  })
  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect(errorMessages()).toHaveLength(errorMark)
  expect(await onlySubscriptionPayment()).toMatchObject({id: payment.id})
  expect(String(requiredPhoto().caption)).toContain(payment.paymentRequest)
})

test('an expired subscription is banned, unbanned and deleted once', async () => {
  const subscription = await seedExpiringSubscription(e2e, {
    price: PRICE,
    endsInMs: -60_000,
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: subscription.id}),
      },
    },
    telegram: expiryTelegramCalls(),
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectExactExpiryCalls()
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([])
  expectNoErrors(e2e.logs)

  const telegramMark = e2e.tg.calls.length
  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {})
  expect(e2e.tg.calls).toHaveLength(telegramMark)
})

// docs/known-issues.md — "Expiry cleanup deletes the subscription even when ban or unban fails"
test('a failed ban keeps the expired row for a later kick retry', async () => {
  const subscription = await seedExpiringSubscription(e2e, {endsInMs: -60_000})
  e2e.tg.fail('banChatMember', {error_code: 400, description: 'Injected ban failure'})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    telegram: [{method: 'banChatMember', to: CHAT_GROUP}],
  })

  const afterFail = await snapshot(e2e)
  expectLedgerBalanced(before, afterFail)
  expect(afterFail.db).toEqual(before.db)
  expect(e2e.tg.of('banChatMember')).toHaveLength(1)
  expect(e2e.tg.of('unbanChatMember')).toHaveLength(0)
  expect(errorMessages()).toEqual(['Error while banning user from chat.'])
  // findByUserAndChat hides expired rows; assert the kick retry state is still on disk.
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([
    expect.objectContaining({id: subscription.id}),
  ])

  // One-shot fail is spent; the next tick completes ban → unban → delete.
  const errorMark = errorMessages().length
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: subscription.id}),
      },
    },
    telegram: expiryTelegramCalls(),
  })
  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect(errorMessages()).toHaveLength(errorMark)
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([])
})

// docs/known-issues.md — "Expiry cleanup deletes the subscription even when ban or unban fails"
test('a failed unban keeps the expired row for a later unban retry', async () => {
  const subscription = await seedExpiringSubscription(e2e, {endsInMs: -60_000})
  e2e.tg.fail('unbanChatMember', {error_code: 403, description: 'Injected unban failure'})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    telegram: expiryTelegramCalls(),
  })

  const afterFail = await snapshot(e2e)
  expectLedgerBalanced(before, afterFail)
  expect(afterFail.db).toEqual(before.db)
  expectExactExpiryCalls()
  expect(errorMessages()).toEqual(['Error while unbanning user from chat.'])
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([
    expect.objectContaining({id: subscription.id}),
  ])

  // One-shot fail is spent; the next tick redoes ban → unban and deletes.
  const errorMark = errorMessages().length
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: subscription.id}),
      },
    },
    telegram: expiryTelegramCalls(),
  })
  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect(errorMessages()).toHaveLength(errorMark)
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([])
  expect(e2e.tg.of('banChatMember')).toHaveLength(2)
  expect(e2e.tg.of('unbanChatMember')).toHaveLength(2)
})

test('expiry includes the exact end instant but not the following second', async () => {
  const now = new Date('2030-01-02T03:04:05.000Z')
  setSystemTime(now)
  const exact = await seedSubscription(e2e, {price: PRICE, endsAt: now})
  await seedChat(e2e, {id: CHAT_GROUP - 1, status: 'active', paymentType: 'monthly'})
  const future = await seedSubscription(e2e, {
    chatId: CHAT_GROUP - 1,
    price: PRICE,
    endsAt: new Date(now.getTime() + 1000),
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: exact.id}),
      },
    },
    telegram: expiryTelegramCalls(),
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([future])
  expectExactExpiryCalls()
  expectNoErrors(e2e.logs)
})

test('a permanent subscription is never treated as expired', async () => {
  const permanent = await seedSubscription(e2e, {price: PRICE, endsAt: null})
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  expect(await requiredSubscription()).toEqual(permanent)
  expect(e2e.tg.calls).toEqual([])
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expectNoErrors(e2e.logs)
})

async function issueManualRenewal(subscription: Subscription, invoiceSats: number) {
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {
        changed: 1,
        match: rows => expectNotificationMarked(rows, subscription),
      },
      subscriptionIntents: {added: 1},
      subscriptionPayments: {
        added: 1,
        match: rows => expectRenewalPayment(rows[0]?.after, PRICE),
      },
    },
    lnbits: {payments: [{out: false, sats: invoiceSats, times: 1}]},
    telegram: [{method: 'sendPhoto', to: USER_A, text: /истекает через 24 часа/}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  const payment = await onlySubscriptionPayment()
  const photo = requiredPhoto()
  expect(photo.caption).toBe(
    translate('subscription-renewal.need-payment', 'ru', {
      title: 'E2E paid chat',
      price: subscription.price,
      invoice: payment.paymentRequest,
    }),
  )
  expect(await requiredSubscription()).toMatchObject({
    id: subscription.id,
    endsAt: subscription.endsAt,
    notificationSent: true,
  })
  expectRenewalPayouts(0)
  expectNoErrors(e2e.logs)
  return {payment, photo}
}

function expectRenewedSubscription(
  rows: {before?: unknown; after?: unknown}[],
  subscription: Subscription,
): void {
  expect(rows).toHaveLength(1)
  expect(rows[0]?.before).toMatchObject({id: subscription.id, endsAt: subscription.endsAt})
  expect(rows[0]?.after).toMatchObject({
    id: subscription.id,
    price: subscription.price,
    endsAt: extendedEndsAt(subscription),
    autoRenew: subscription.autoRenew,
    notificationSent: false,
  })
}

function expectNotificationMarked(
  rows: {before?: unknown; after?: unknown}[],
  subscription: Subscription,
): void {
  expect(rows).toHaveLength(1)
  expect(rows[0]?.before).toMatchObject({
    id: subscription.id,
    endsAt: subscription.endsAt,
    notificationSent: false,
  })
  expect(rows[0]?.after).toMatchObject({
    id: subscription.id,
    endsAt: subscription.endsAt,
    notificationSent: true,
  })
}

function expectRenewalPayment(value: unknown, price: number): void {
  expect(value).toMatchObject({
    userId: USER_A,
    chatId: CHAT_GROUP,
    price,
    subscriptionType: 'monthly',
    kind: 'renewal',
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
  })
}

function successfulRenewalEvents(price: number) {
  return [
    {out: false, sats: price, times: 1},
    {out: true, sats: price, times: 1},
    ...payoutEvents(),
  ]
}

function payoutEvents() {
  return [
    {out: false, sats: OWNER_PAYOUT, times: 1},
    {out: true, sats: OWNER_PAYOUT, times: 1},
    {out: false, sats: FEE, times: 1},
    {out: true, sats: FEE, times: 1},
  ]
}

function successfulRenewalTelegramCalls() {
  return [
    {method: 'approveChatJoinRequest', to: CHAT_GROUP},
    {method: 'sendMessage', to: USER_A, text: /подписка .* продлена/},
    {method: 'sendMessage', to: OWNER, text: /New subscription payment/},
  ]
}

function expiryTelegramCalls() {
  return [
    {method: 'banChatMember', to: CHAT_GROUP},
    {method: 'unbanChatMember', to: CHAT_GROUP},
  ]
}

function expectExactApproval(): void {
  expect(e2e.tg.of('approveChatJoinRequest')).toHaveLength(1)
  expect(e2e.tg.of('approveChatJoinRequest')[0]).toMatchObject({
    chat_id: CHAT_GROUP,
    user_id: USER_A,
  })
}

function expectExactExpiryCalls(): void {
  expect(e2e.tg.of('banChatMember')).toEqual([
    {chat_id: CHAT_GROUP, user_id: USER_A, parse_mode: 'HTML'},
  ])
  expect(e2e.tg.of('unbanChatMember')).toEqual([
    {chat_id: CHAT_GROUP, user_id: USER_A, parse_mode: 'HTML'},
  ])
}

function expectPaymentRequestOrder(mark: number, price: number): void {
  const requests = paymentRequestsSince(mark)
  expect(requests).toHaveLength(6)
  expect(requests[0]?.body).toMatchObject({
    out: false,
    amount: price,
    unit: 'sat',
    expiry: 24 * 60 * 60,
  })
  expect(requests[1]?.body).toMatchObject({out: true})
  expect(requests[2]?.body).toMatchObject({out: false, amount: OWNER_PAYOUT, unit: 'sat'})
  expect(requests[3]?.body).toMatchObject({out: true})
  expect(requests[4]?.body).toEqual({out: false, amount: FEE, unit: 'sat'})
  expect(requests[5]?.body).toMatchObject({out: true})
}

function expectRenewalPayouts(times: number): void {
  expectPayoutsExactly(e2e.ln, {
    toWallet: walletForUser(OWNER),
    sats: OWNER_PAYOUT,
    times,
  })
  expectPayoutsExactly(e2e.ln, {toWallet: feeWallet(), sats: FEE, times})
}

function creditUser(userId: number, sats: number): void {
  e2e.ln.state.credit(walletForUser(userId).id, sats * 1000)
}

function walletForUser(userId: number): FakeWallet {
  const user = e2e.ln.state.getUserByUsername(String(userId))
  const wallet = user ? e2e.ln.state.walletsOfUser(user.id)[0] : undefined
  if (!wallet) throw new Error(`Fake LNbits wallet not found for ${userId}`)
  return wallet
}

function masterWallet(): FakeWallet {
  const wallet = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!wallet) throw new Error('Fake LNbits master wallet not found')
  return wallet
}

function feeWallet(): FakeWallet {
  const key = e2e.container.config.LNBITS_FEE_COLLECTION_INVOICE_KEY
  const wallet = e2e.ln.state.walletByApiKey(key)
  if (!wallet) throw new Error('Fake LNbits fee wallet not found')
  return wallet
}

function extendedEndsAt(subscription: Subscription): Date {
  if (!subscription.endsAt) throw new Error('Expected a monthly subscription end date')
  return new Date(subscription.endsAt.getTime() + ONE_MONTH_IN_MS)
}

async function requiredSubscription(): Promise<Subscription> {
  const subscription = await e2e.container.subscriptions.findByUserAndChat(USER_A, CHAT_GROUP)
  if (!subscription) throw new Error('Subscription was not found')
  return subscription
}

async function requiredPayment(id: string): Promise<SubscriptionPayment> {
  const payment = await e2e.container.payments.findById(id)
  if (!payment) throw new Error(`Subscription payment ${id} was not found`)
  return payment
}

async function onlySubscriptionPayment(): Promise<SubscriptionPayment> {
  const payments = await e2e.db.query.subscriptionPaymentsTable.findMany()
  expect(payments).toHaveLength(1)
  const payment = payments[0]
  if (!payment) throw new Error('Subscription payment was not found')
  return payment
}

function requiredPhoto(): Record<string, unknown> {
  const photo = e2e.tg.last('sendPhoto')
  if (!photo) throw new Error('Renewal invoice photo was not sent')
  return photo
}

function buttonsOf(payload: Record<string, unknown>): {callback_data?: string; text?: string}[] {
  const markup = payload.reply_markup as
    | {inline_keyboard?: {callback_data?: string; text?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat()
}

function callbackDataOf(payload: Record<string, unknown>): string[] {
  return buttonsOf(payload).flatMap(button => button.callback_data ?? [])
}

function buttonTextsOf(payload: Record<string, unknown>): string[] {
  return buttonsOf(payload).flatMap(button => button.text ?? [])
}

function paymentRequestsSince(mark: number) {
  return e2e.ln.requests
    .slice(mark)
    .filter(request => request.method === 'POST' && request.path === '/api/v1/payments')
}

function errorMessages(mark = 0): string[] {
  return e2e.logs
    .slice(mark)
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function infoMessages(mark = 0): string[] {
  return e2e.logs
    .slice(mark)
    .filter(log => log.level === 'info' || log.level === 30)
    .map(log => String(log.msg ?? ''))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
