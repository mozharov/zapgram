import {afterEach, beforeEach, expect, test} from 'bun:test'
import {ONE_MONTH_IN_MS} from '@core/subscriptions/policy.js'
import type {SubscriptionPayment} from '@infra/db/types.js'
import {MAX_SETTLE_ATTEMPTS} from '@modules/subscriptions/payment-repository.js'
import {expectNoErrors, expectPayoutsExactly, expectWorldUnchanged} from '../asserts.js'
import type {FakePayment, FakeWallet} from '../fakes/lnbits-state.js'
import {CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedChat, seedSubscriptionPayment, seedUser} from '../fixtures/seed.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['subscriptions-settle']

/**
 * The settlement half of paid subscriptions. The subscriber invoice is already paid when each
 * money-moving scenario starts; the job must grant access and distribute that fixed payment at
 * most once across retries and process restarts.
 */

const PRICE = 1000
const FEE = 50
const OWNER_PAYOUT = PRICE - FEE
const FAILURE = {status: 503, body: {detail: 'Injected settlement failure'}}
const EXHAUSTED_PAYMENT_ERROR =
  'Subscription payment exhausted its settle attempts. It will no longer be retried; ' +
  'the row is kept for manual review.'

type SeedOptions = {
  ownerId?: number
  userId?: number
  ownerHasLnbitsWallet?: boolean
  chatPrice?: number
  chatStatus?: 'active' | 'inactive' | 'no_access'
  paymentPrice?: number
  subscriptionType?: 'one_time' | 'monthly'
  settleAttempts?: number
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('a paid one-time invoice grants access and distributes the exact price once', async () => {
  const payment = await seedPaidSettlement()
  const requestMark = e2e.ln.requests.length

  await expectSuccessfulSettlement(payment)

  const payoutRequests = paymentRequestsSince(requestMark)
  expect(payoutRequests).toHaveLength(4)
  expect(payoutRequests[0]?.body).toMatchObject({
    out: false,
    amount: OWNER_PAYOUT,
    unit: 'sat',
    expiry: 24 * 60 * 60,
  })
  expect(payoutRequests[1]?.body).toMatchObject({out: true})
  expect(payoutRequests[2]?.body).toEqual({out: false, amount: FEE, unit: 'sat'})
  expect(payoutRequests[3]?.body).toMatchObject({out: true})

  const [subscriberMessage, ownerMessage] = e2e.tg.of('sendMessage')
  expect(String(subscriberMessage?.text)).toMatch(
    /Access to the community "E2E paid chat" received/,
  )
  expect(String(subscriberMessage?.text)).not.toContain('automatically debited')
  expect(String(ownerMessage?.text)).toContain(
    'Subscription type: <b>one-time (permanent access)</b>',
  )
  expect(String(ownerMessage?.text)).toMatch(
    /Payment amount: <b>1\D?000 sats(?: \(\$[^)]+\))?<\/b>/,
  )
  expect(String(ownerMessage?.text)).toMatch(/Fee: <b>50 sats(?: \(\$[^)]+\))?<\/b>/)
  expect(String(ownerMessage?.text)).toMatch(/Credited: <b>950 sats(?: \(\$[^)]+\))?<\/b>/)
  expectNoErrors(e2e.logs)
})

test('a monthly settlement is unchanged when the job runs again', async () => {
  const payment = await seedPaidSettlement({subscriptionType: 'monthly'})
  const earliestEnd = Date.now() + ONE_MONTH_IN_MS

  const subscription = await expectSuccessfulSettlement(payment)

  const latestEnd = Date.now() + ONE_MONTH_IN_MS
  // SQLite stores timestamps at one-second precision.
  expect(subscription.endsAt?.getTime()).toBeGreaterThanOrEqual(earliestEnd - 1000)
  expect(subscription.endsAt?.getTime()).toBeLessThanOrEqual(latestEnd)
  const afterFirstRun = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})

  const afterSecondRun = await snapshot(e2e)
  expectWorldUnchanged(afterFirstRun, afterSecondRun)
  expectLedgerBalanced(afterFirstRun, afterSecondRun)
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect((await e2e.container.subscriptions.findByUserAndChat(USER_A, CHAT_GROUP))?.endsAt).toEqual(
    subscription.endsAt,
  )
  const [subscriberMessage, ownerMessage] = e2e.tg.of('sendMessage')
  expect(String(subscriberMessage?.text)).toContain('automatically debited')
  expect(String(ownerMessage?.text)).toContain('Subscription type: <b>monthly</b>')
  expectPayouts(OWNER, 1, 1)
  expectNoErrors(e2e.logs)
})

test('a zero fee transfers the whole payment to the owner and creates no fee leg', async () => {
  await recreateWorld({env: {SUBSCRIPTION_FEE_PERCENT: '0'}})
  const payment = await seedPaidSettlement()
  const requestMark = e2e.ln.requests.length

  await expectSuccessfulSettlement(payment, {fee: 0})

  expect(
    paymentRequestsSince(requestMark).some(request => {
      const body = asRecord(request.body)
      return body?.out === false && body.amount === FEE
    }),
  ).toBe(false)
  const ownerMessage = e2e.tg.of('sendMessage')[1]
  expect(String(ownerMessage?.text)).toMatch(/Fee: <b>0 sats(?: \(\$[^)]+\))?<\/b>/)
  expect(String(ownerMessage?.text)).toMatch(/Credited: <b>1\D?000 sats(?: \(\$[^)]+\))?<\/b>/)
  expectNoErrors(e2e.logs)
})

test('an owner payout still in flight keeps the row and preserves its hash', async () => {
  const payment = await seedPaidSettlement()
  const pending = seedPendingOutgoing(walletForUser(OWNER), OWNER_PAYOUT)
  await e2e.container.payments.recordPayoutInvoice(payment.id, pending.paymentHash)
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows => expectKeptPayment(rows, payment, {payoutHash: pending.paymentHash}),
      },
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectPayouts(OWNER, 0, 0)
  expect(e2e.tg.of('sendMessage')).toEqual([])
  expectNoErrors(e2e.logs)
})

test('a pending fee leg is logged as fee collection with the fee hash', async () => {
  await recreateWorld({env: {LOG_LEVEL: 'info'}})
  const payment = await seedPaidSettlement()
  const ownerInvoice = payPayout(walletForUser(OWNER), OWNER_PAYOUT)
  await e2e.container.payments.recordPayoutInvoice(payment.id, ownerInvoice.paymentHash)
  const feePending = seedPendingOutgoing(feeWallet(), FEE)
  await e2e.container.payments.recordFeePayoutInvoice(payment.id, feePending.paymentHash)
  const logMark = e2e.logs.length
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows =>
          expectKeptPayment(rows, payment, {
            payoutHash: ownerInvoice.paymentHash,
            feePayoutHash: feePending.paymentHash,
          }),
      },
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectPayouts(OWNER, 1, 0)
  const pendingLog = e2e.logs
    .slice(logMark)
    .find(
      log =>
        log.msg === 'Fee collection is still in flight at LNbits; re-checking on the next tick.',
    )
  expect(pendingLog).toMatchObject({
    leg: 'fee',
    hash: feePending.paymentHash,
  })
  expect(pendingLog?.hash).not.toBe(ownerInvoice.paymentHash)
  expectNoErrors(e2e.logs)
})

test('a missing stored payout hash reissues the owner transfer after a 404', async () => {
  const payment = await seedPaidSettlement()
  const missingHash = 'f'.repeat(64)
  await e2e.container.payments.recordPayoutInvoice(payment.id, missingHash)
  const requestMark = e2e.ln.requests.length

  await expectSuccessfulSettlement(payment)

  expect(
    e2e.ln.requests.slice(requestMark).some(request => {
      return request.method === 'GET' && request.path === `/api/v1/payments/${missingHash}`
    }),
  ).toBe(true)
  expectPayouts(OWNER, 1, 1)
  expectNoErrors(e2e.logs)
})

test('a restart after payout invoice creation still pays the owner exactly once', async () => {
  await recreateWorld({mode: 'file'})
  const payment = await seedPaidSettlement({subscriptionType: 'monthly'})
  e2e.ln.state.failNext(
    {method: 'POST', path: '/api/v1/payments', body: body => asRecord(body)?.out === true},
    FAILURE,
  )
  const beforeFailure = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows => expectKeptPayment(rows, payment),
      },
    },
    lnbits: {payments: [{out: false, sats: OWNER_PAYOUT, times: 1}]},
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const afterFailure = await snapshot(e2e)
  expectLedgerBalanced(beforeFailure, afterFailure)
  const kept = await requiredPayment(payment.id)
  expect(kept.payoutHash).toBeString()
  expect(kept.feePayoutHash).toBeNull()
  const orphan = e2e.ln.state.payments.find(candidate => candidate.paymentHash === kept.payoutHash)
  expect(orphan).toMatchObject({walletId: walletForUser(OWNER).id, paid: false, out: false})
  const endsAt = (await requiredSubscription()).endsAt
  expectPayouts(OWNER, 0, 0)
  expect(errorMessages()).toEqual(['Failed to distribute subscription payment.'])

  const restartLogMark = e2e.logs.length
  await e2e.restart()
  const beforeRetry = await snapshot(e2e)
  expectWorldUnchanged(afterFailure, beforeRetry)
  expect(await requiredPayment(payment.id)).toEqual(kept)
  expect(errorMessages(restartLogMark)).toEqual([])
  const retryLogMark = e2e.logs.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {removed: 1},
    },
    lnbits: {
      balances: {
        'master wallet': -PRICE,
        [walletForUser(OWNER).name]: OWNER_PAYOUT,
        [feeWallet().name]: FEE,
      },
      payments: successfulPaymentEvents(OWNER_PAYOUT, FEE),
    },
    telegram: successfulTelegramCalls(USER_A, OWNER),
  })

  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect((await requiredSubscription()).endsAt).toEqual(endsAt)
  expect(orphan?.paid).toBe(false)
  expectPayouts(OWNER, 1, 1)
  expect(errorMessages(retryLogMark)).toEqual([])
})

test('a restart between owner and fee legs never repeats the owner payout', async () => {
  await recreateWorld({mode: 'file'})
  const payment = await seedPaidSettlement({subscriptionType: 'monthly'})
  e2e.ln.state.failNext(
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: body => {
        const record = asRecord(body)
        return record?.out === false && record.amount === FEE
      },
    },
    FAILURE,
  )
  const beforeFailure = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows => expectKeptPayment(rows, payment),
      },
    },
    lnbits: {
      balances: {'master wallet': -OWNER_PAYOUT, [walletForUser(OWNER).name]: OWNER_PAYOUT},
      payments: [
        {out: false, sats: OWNER_PAYOUT, times: 1},
        {out: true, sats: OWNER_PAYOUT, times: 1},
      ],
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const afterFailure = await snapshot(e2e)
  expectLedgerBalanced(beforeFailure, afterFailure)
  const kept = await requiredPayment(payment.id)
  expect(kept.payoutHash).toBeString()
  expect(kept.feePayoutHash).toBeNull()
  const endsAt = (await requiredSubscription()).endsAt
  expectPayouts(OWNER, 1, 0)
  expect(errorMessages()).toEqual(['Failed to distribute subscription payment.'])

  const restartLogMark = e2e.logs.length
  await e2e.restart()
  const requestMark = e2e.ln.requests.length
  const beforeRetry = await snapshot(e2e)
  expectWorldUnchanged(afterFailure, beforeRetry)
  expect(await requiredPayment(payment.id)).toEqual(kept)
  expect(errorMessages(restartLogMark)).toEqual([])
  const retryLogMark = e2e.logs.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {removed: 1},
    },
    lnbits: {
      balances: {'master wallet': -FEE, [feeWallet().name]: FEE},
      payments: [
        {out: false, sats: FEE, times: 1},
        {out: true, sats: FEE, times: 1},
      ],
    },
    telegram: successfulTelegramCalls(USER_A, OWNER),
  })

  const afterRetry = await snapshot(e2e)
  expectLedgerBalanced(beforeRetry, afterRetry)
  expect((await requiredSubscription()).endsAt).toEqual(endsAt)
  expect(
    paymentRequestsSince(requestMark).some(
      request => asRecord(request.body)?.amount === OWNER_PAYOUT,
    ),
  ).toBe(false)
  expectPayouts(OWNER, 1, 1)
  expect(errorMessages(retryLogMark)).toEqual([])
})

test('an expired unpaid subscription invoice is deleted without moving money', async () => {
  await seedSettlementActors()
  const payment = await seedSubscriptionPayment(e2e, {paid: false, expiresInMs: -60_000})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: payment.id, settleAttempts: 0}),
      },
    },
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.container.subscriptions.findByUserAndChat(USER_A, CHAT_GROUP)).toBeUndefined()
  expectPayouts(OWNER, 0, 0)
  expect(e2e.tg.calls).toEqual([])
  expectNoErrors(e2e.logs)
})

test('a chat lookup failure keeps the granted payment without paying out', async () => {
  const payment = await seedPaidSettlement()
  e2e.container.chats.getOrThrow = async () => {
    throw new Error('Injected chat lookup failure')
  }

  await expectLookupFailure(payment, 'Failed to get chat information.')
})

test('a subscriber lookup failure keeps the granted payment without paying out', async () => {
  const payment = await seedPaidSettlement()
  e2e.container.users.getOrThrow = async () => {
    throw new Error('Injected user lookup failure')
  }

  await expectLookupFailure(payment, 'Failed to get user information.')
})

test('an already exhausted payment is not selected and emits the aggregate alert', async () => {
  const payment = await seedPaidSettlement({settleAttempts: MAX_SETTLE_ATTEMPTS})
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect(await requiredPayment(payment.id)).toEqual(payment)
  expect(errorMessages()).toEqual([
    'Subscription payments are stuck past their settle attempt budget and need manual review.',
  ])
  expectPayouts(OWNER, 0, 0)
})

test('the last pending attempt reaches the limit and is excluded from the next run', async () => {
  const payment = await seedPaidSettlement({settleAttempts: MAX_SETTLE_ATTEMPTS - 1})
  const pending = seedPendingOutgoing(walletForUser(OWNER), OWNER_PAYOUT)
  await e2e.container.payments.recordPayoutInvoice(payment.id, pending.paymentHash)
  const beforeLastAttempt = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows =>
          expectKeptPayment(rows, payment, {
            payoutHash: pending.paymentHash,
            settleAttempts: MAX_SETTLE_ATTEMPTS,
          }),
      },
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const afterLastAttempt = await snapshot(e2e)
  expectLedgerBalanced(beforeLastAttempt, afterLastAttempt)
  expect(errorMessages()).toContain(EXHAUSTED_PAYMENT_ERROR)
  const requestMark = e2e.ln.requests.length
  const logMark = e2e.logs.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})

  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect(errorMessages(logMark)).toEqual([
    'Subscription payments are stuck past their settle attempt budget and need manual review.',
  ])
  expectPayouts(OWNER, 0, 0)
})

test('two paid attempts of one intent pay the owner once and refund the duplicate in full', async () => {
  const {first, second} = await seedSharedAttempts({firstPaid: true, secondPaid: true})
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {
        changed: 1,
        match: rows =>
          expect(rows[0]?.after).toMatchObject({
            status: 'completed',
            winnerAttemptId: expect.any(String),
          }),
      },
      subscriptionPayments: {
        changed: 2,
        match: rows => {
          expect(rows.map(row => asRecord(row.after)?.id).sort()).toEqual(
            [first.id, second.id].sort(),
          )
          expect(rows.map(row => asRecord(row.after)?.attemptStatus)).toEqual([
            'processed',
            'processed',
          ])
        },
      },
    },
    lnbits: {
      balances: {
        'master wallet': -2 * PRICE,
        [walletForUser(OWNER).name]: OWNER_PAYOUT,
        [feeWallet().name]: FEE,
        [walletForUser(USER_A).name]: PRICE,
      },
      payments: [
        {out: false, sats: OWNER_PAYOUT, times: 1},
        {out: true, sats: OWNER_PAYOUT, times: 1},
        {out: false, sats: FEE, times: 1},
        {out: true, sats: FEE, times: 1},
        {out: false, sats: PRICE, times: 1},
        {out: true, sats: PRICE, times: 1},
      ],
    },
    telegram: [
      ...successfulTelegramCalls(USER_A, OWNER),
      {method: 'sendMessage', to: USER_A, text: /repeated subscription payment.*credited/},
    ],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.container.db.query.subscriptionsTable.findMany()).toEqual([
    expect.objectContaining({userId: USER_A, chatId: CHAT_GROUP, endsAt: null}),
  ])
  expectPayouts(OWNER, 1, 1)
  expectPayoutsExactly(e2e.ln, {toWallet: walletForUser(USER_A), sats: PRICE, times: 1})
  const attempts = await Promise.all([
    e2e.container.payments.findById(first.id),
    e2e.container.payments.findById(second.id),
  ])
  expect(attempts.filter(attempt => attempt?.refundedAt)).toHaveLength(1)
  expect(attempts.filter(attempt => attempt?.settledAt)).toHaveLength(1)

  const settled = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})
  expectWorldUnchanged(settled, await snapshot(e2e))
  expectPayouts(OWNER, 1, 1)
  expectPayoutsExactly(e2e.ln, {toWallet: walletForUser(USER_A), sats: PRICE, times: 1})
  expectNoErrors(e2e.logs)
})

test('a refund retry after failure before hash persistence succeeds once after restart', async () => {
  await recreateWorld({mode: 'file'})
  const duplicate = await preparePaidDuplicate('ru')
  e2e.ln.state.failNext(
    {
      method: 'POST',
      path: '/api/v1/payments',
      body: body => {
        const record = asRecord(body)
        return record?.out === false && record.amount === PRICE
      },
    },
    FAILURE,
  )
  const beforeFailure = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
  })

  const afterFailure = await requiredPayment(duplicate.id)
  expect(afterFailure).toMatchObject({
    refundPayoutHash: null,
    refundedAt: null,
    attemptStatus: 'pending',
  })
  expectLedgerBalanced(beforeFailure, await snapshot(e2e))
  expectAllSettlementPayouts(0)
  expect(e2e.tg.of('sendMessage')).toHaveLength(2)

  await e2e.restart()
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
    lnbits: {
      balances: {'master wallet': -PRICE, [walletForUser(USER_A).name]: PRICE},
      payments: [
        {out: false, sats: PRICE, times: 1},
        {out: true, sats: PRICE, times: 1},
      ],
    },
    telegram: [{method: 'sendMessage', to: USER_A, text: /Повторный платёж.*зачислен/}],
  })

  expectLedgerBalanced(beforeRetry, await snapshot(e2e))
  expect(await requiredPayment(duplicate.id)).toMatchObject({
    refundPayoutHash: expect.any(String),
    refundedAt: expect.any(Date),
    attemptStatus: 'processed',
  })
  expectAllSettlementPayouts(1)
})

test('a persisted refund hash is recovered through 404 without paying twice', async () => {
  await recreateWorld({mode: 'file'})
  const duplicate = await preparePaidDuplicate('ru')
  e2e.ln.state.failNext(
    {method: 'POST', path: '/api/v1/payments', body: body => asRecord(body)?.out === true},
    FAILURE,
  )

  await e2e.jobs.subscriptionPayments()
  const afterFailure = await requiredPayment(duplicate.id)
  if (!afterFailure.refundPayoutHash) throw new Error('Refund hash was not persisted')
  expect(afterFailure).toMatchObject({refundedAt: null, attemptStatus: 'pending'})
  const orphan = e2e.ln.state.payments.find(
    payment => payment.paymentHash === afterFailure.refundPayoutHash && !payment.out,
  )
  expect(orphan).toMatchObject({paid: false, walletId: walletForUser(USER_A).id})
  expectAllSettlementPayouts(0)

  await e2e.restart()
  const requestMark = e2e.ln.requests.length
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
    lnbits: {
      balances: {'master wallet': -PRICE, [walletForUser(USER_A).name]: PRICE},
      payments: [
        {out: false, sats: PRICE, times: 1},
        {out: true, sats: PRICE, times: 1},
      ],
    },
    telegram: [{method: 'sendMessage', to: USER_A, text: /Повторный платёж.*зачислен/}],
  })

  expectLedgerBalanced(beforeRetry, await snapshot(e2e))
  expect(
    e2e.ln.requests
      .slice(requestMark)
      .some(request => request.path === `/api/v1/payments/${afterFailure.refundPayoutHash}`),
  ).toBe(true)
  expect(orphan?.paid).toBe(false)
  expect((await requiredPayment(duplicate.id)).refundPayoutHash).not.toBe(
    afterFailure.refundPayoutHash,
  )
  expectAllSettlementPayouts(1)
})

test('a crash after the actual refund payment confirms it after restart without a second payout', async () => {
  await recreateWorld({mode: 'file'})
  const duplicate = await preparePaidDuplicate('ru')
  const payInvoice = e2e.container.masterWallet.payInvoice.bind(e2e.container.masterWallet)
  let crashOnce = true
  e2e.container.masterWallet.payInvoice = async bolt11 => {
    const result = await payInvoice(bolt11)
    if (crashOnce) {
      crashOnce = false
      throw new Error('Injected crash after actual refund payment')
    }
    return result
  }
  const beforeFailure = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
    lnbits: {
      balances: {'master wallet': -PRICE, [walletForUser(USER_A).name]: PRICE},
      payments: [
        {out: false, sats: PRICE, times: 1},
        {out: true, sats: PRICE, times: 1},
      ],
    },
  })

  expectLedgerBalanced(beforeFailure, await snapshot(e2e))
  expect(await requiredPayment(duplicate.id)).toMatchObject({
    refundPayoutHash: expect.any(String),
    refundedAt: null,
    attemptStatus: 'pending',
  })
  expectAllSettlementPayouts(1)

  await e2e.restart()
  const beforeRetry = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /Повторный платёж.*зачислен/}],
  })

  expectLedgerBalanced(beforeRetry, await snapshot(e2e))
  expect(await requiredPayment(duplicate.id)).toMatchObject({
    refundedAt: expect.any(Date),
    attemptStatus: 'processed',
  })
  expectAllSettlementPayouts(1)
})

test('a pending refund reaches the retry budget without notification and raises the alert', async () => {
  const duplicate = await preparePaidDuplicate('ru', MAX_SETTLE_ATTEMPTS - 1)
  const pending = seedPendingOutgoing(walletForUser(USER_A), PRICE)
  await e2e.container.payments.recordRefundInvoice(duplicate.id, pending.paymentHash)
  const messageMark = e2e.tg.of('sendMessage').length
  const beforeLastAttempt = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {subscriptionPayments: {changed: 1}},
  })

  expectLedgerBalanced(beforeLastAttempt, await snapshot(e2e))
  expect(await requiredPayment(duplicate.id)).toMatchObject({
    settleAttempts: MAX_SETTLE_ATTEMPTS,
    refundPayoutHash: pending.paymentHash,
    refundedAt: null,
    attemptStatus: 'pending',
  })
  expect(e2e.tg.of('sendMessage')).toHaveLength(messageMark)
  expectAllSettlementPayouts(0)
  expect(errorMessages()).toContain(EXHAUSTED_PAYMENT_ERROR)

  const logMark = e2e.logs.length
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})
  expect(errorMessages(logMark)).toEqual([
    'Subscription payments are stuck past their settle attempt budget and need manual review.',
  ])
  expectAllSettlementPayouts(0)
})

test('an approval failure keeps the payment without paying out or notifying', async () => {
  const payment = await seedPaidSettlement({chatStatus: 'no_access'})
  e2e.tg.fail('approveChatJoinRequest', {
    error_code: 400,
    description: 'Bad Request: not enough rights',
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {
        added: 1,
        match: rows => {
          expect(rows[0]?.after).toMatchObject({
            userId: payment.userId,
            chatId: payment.chatId,
            price: payment.price,
            endsAt: null,
          })
        },
      },
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows => expectKeptPayment(rows, payment),
      },
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await requiredPayment(payment.id)).toMatchObject({
    settleAttempts: payment.settleAttempts + 1,
    settledAt: expect.any(Date),
  })
  expect(e2e.tg.of('approveChatJoinRequest')).toHaveLength(1)
  expect(e2e.tg.of('sendMessage')).toEqual([])
  expectPayouts(OWNER, 0, 0)
  expect(errorMessages()).toEqual(['Error while approving chat join request.'])
})

test('settlement uses the invoiced price after the chat price changes', async () => {
  const payment = await seedPaidSettlement({chatPrice: 2000, paymentPrice: PRICE})

  const subscription = await expectSuccessfulSettlement(payment)

  expect(subscription.price).toBe(PRICE)
  expect((await e2e.container.chats.getOrThrow(CHAT_GROUP)).price).toBe(2000)
  expect(String(e2e.tg.of('sendMessage')[1]?.text)).toMatch(
    /Payment amount: <b>1\D?000 sats(?: \(\$[^)]+\))?<\/b>/,
  )
  expectNoErrors(e2e.logs)
})

test('the subscriber can also be the owner without breaking the ledger', async () => {
  const payment = await seedPaidSettlement({ownerId: USER_A, userId: USER_A})

  await expectSuccessfulSettlement(payment, {ownerId: USER_A, userId: USER_A})

  expect(e2e.tg.of('sendMessage').map(message => message.chat_id)).toEqual([USER_A, USER_A])
  expectPayouts(USER_A, 1, 1)
  expectNoErrors(e2e.logs)
})

test('an owner without an LNbits account is provisioned before payout', async () => {
  const payment = await seedPaidSettlement({ownerHasLnbitsWallet: false})
  expect(e2e.ln.state.getUserByUsername(String(OWNER))).toBeUndefined()
  const requestMark = e2e.ln.requests.length

  await expectSuccessfulSettlement(payment)

  expect(e2e.ln.state.getUserByUsername(String(OWNER))).toBeDefined()
  expect(
    e2e.ln.requests.slice(requestMark).some(request => {
      return (
        request.method === 'POST' &&
        request.path === '/users/api/v1/user' &&
        asRecord(request.body)?.username === String(OWNER)
      )
    }),
  ).toBe(true)
  expectPayouts(OWNER, 1, 1)
  expectNoErrors(e2e.logs)
})

async function seedPaidSettlement(options: SeedOptions = {}): Promise<SubscriptionPayment> {
  const ownerId = options.ownerId ?? OWNER
  const userId = options.userId ?? USER_A

  if (options.ownerHasLnbitsWallet === false) {
    await e2e.container.users.createOrUpdate({
      id: ownerId,
      username: 'owner',
      firstName: 'Owner',
      languageCode: 'en',
      nwcTips: false,
      nwcUrl: null,
    })
  } else {
    await seedUser(e2e, {id: ownerId, username: 'owner', firstName: 'Owner'})
  }

  if (userId !== ownerId) {
    await seedUser(e2e, {id: userId, username: 'subscriber', firstName: 'Subscriber'})
  }

  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId,
    title: 'E2E paid chat',
    status: options.chatStatus ?? 'active',
    price: options.chatPrice ?? options.paymentPrice ?? PRICE,
    paymentType: options.subscriptionType ?? 'one_time',
  })

  return seedSubscriptionPayment(e2e, {
    userId,
    chatId: CHAT_GROUP,
    paid: true,
    price: options.paymentPrice ?? PRICE,
    subscriptionType: options.subscriptionType ?? 'one_time',
    settleAttempts: options.settleAttempts,
  })
}

async function seedSettlementActors(): Promise<void> {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  await seedUser(e2e, {id: USER_A, username: 'subscriber', firstName: 'Subscriber'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: PRICE})
}

async function seedSharedAttempts(options: {
  firstPaid: boolean
  secondPaid: boolean
  languageCode?: 'en' | 'ru'
  secondSettleAttempts?: number
}): Promise<{first: SubscriptionPayment; second: SubscriptionPayment}> {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner', languageCode: 'en'})
  await seedUser(e2e, {
    id: USER_A,
    username: 'subscriber',
    firstName: 'Subscriber',
    languageCode: options.languageCode ?? 'en',
  })
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E paid chat',
    status: 'active',
    price: PRICE,
    paymentType: 'one_time',
  })
  const intent = await e2e.container.subscriptionIntents.create({
    userId: USER_A,
    chatId: CHAT_GROUP,
    kind: 'join',
  })
  const first = await seedSubscriptionPayment(e2e, {
    intentId: intent.id,
    isCurrent: false,
    paid: options.firstPaid,
  })
  const second = await seedSubscriptionPayment(e2e, {
    intentId: intent.id,
    isCurrent: true,
    paid: options.secondPaid,
    settleAttempts: options.secondSettleAttempts,
  })
  return {first, second}
}

async function preparePaidDuplicate(
  languageCode: 'en' | 'ru',
  settleAttempts = 0,
): Promise<SubscriptionPayment> {
  const {first, second} = await seedSharedAttempts({
    firstPaid: true,
    secondPaid: false,
    languageCode,
    secondSettleAttempts: settleAttempts,
  })
  await e2e.jobs.subscriptionPayments()
  expect(await requiredPayment(first.id)).toMatchObject({
    attemptStatus: 'processed',
    settledAt: expect.any(Date),
  })
  expect(await requiredPayment(second.id)).toMatchObject({
    attemptStatus: 'pending',
    refundedAt: null,
  })
  expectAllSettlementPayouts(0)

  const incoming = e2e.ln.state.payments.find(
    payment => payment.paymentHash === second.paymentHash && !payment.out,
  )
  if (!incoming) throw new Error('Duplicate subscriber invoice was not found')
  const payer = walletForUser(USER_A)
  e2e.ln.state.credit(payer.id, incoming.amountMsat)
  e2e.ln.state.payInvoice({payerWallet: payer, bolt11: incoming.bolt11})
  return second
}

async function expectSuccessfulSettlement(
  payment: SubscriptionPayment,
  options: {ownerId?: number; userId?: number; fee?: number} = {},
) {
  const ownerId = options.ownerId ?? OWNER
  const userId = options.userId ?? USER_A
  const fee = options.fee ?? FEE
  const ownerPayout = payment.price - fee
  const before = await snapshot(e2e)
  const telegramMark = e2e.tg.calls.length

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {
        added: 1,
        match: rows => {
          expect(rows[0]?.after).toMatchObject({
            userId,
            chatId: payment.chatId,
            price: payment.price,
            endsAt: payment.subscriptionType === 'one_time' ? null : expect.any(Date),
            autoRenew: true,
            notificationSent: false,
          })
        },
      },
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: payment.id}),
      },
    },
    lnbits: {
      balances: {
        'master wallet': -payment.price,
        [walletName(ownerId)]: ownerPayout,
        ...(fee > 0 ? {[feeWallet().name]: fee} : {}),
      },
      payments: successfulPaymentEvents(ownerPayout, fee),
    },
    telegram: successfulTelegramCalls(userId, ownerId),
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectPayoutsExactly(e2e.ln, {toWallet: walletName(ownerId), sats: ownerPayout, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees wallet', sats: fee, times: fee > 0 ? 1 : 0})
  expect(await e2e.container.payments.findById(payment.id)).toBeUndefined()
  expect(e2e.tg.calls[telegramMark]).toMatchObject({
    method: 'approveChatJoinRequest',
    payload: {chat_id: payment.chatId, user_id: userId},
  })
  return requiredSubscription(userId, payment.chatId)
}

async function expectLookupFailure(payment: SubscriptionPayment, errorMessage: string) {
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {
        added: 1,
        match: rows => {
          expect(rows[0]?.after).toMatchObject({
            userId: payment.userId,
            chatId: payment.chatId,
            price: payment.price,
            endsAt: null,
          })
        },
      },
      subscriptionIntents: {changed: 1},
      subscriptionPayments: {
        changed: 1,
        match: rows => expectKeptPayment(rows, payment),
      },
    },
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await requiredPayment(payment.id)).toMatchObject({
    settleAttempts: payment.settleAttempts + 1,
    settledAt: expect.any(Date),
  })
  expect(e2e.tg.of('approveChatJoinRequest')).toHaveLength(1)
  expect(e2e.tg.of('approveChatJoinRequest')[0]).toMatchObject({
    chat_id: payment.chatId,
    user_id: payment.userId,
  })
  expect(e2e.tg.of('sendMessage')).toEqual([])
  expectPayouts(OWNER, 0, 0)
  expect(errorMessages()).toEqual([errorMessage])
}

function successfulPaymentEvents(ownerPayout: number, fee: number) {
  return [
    {out: false, sats: ownerPayout, times: 1},
    {out: true, sats: ownerPayout, times: 1},
    ...(fee > 0
      ? [
          {out: false, sats: fee, times: 1},
          {out: true, sats: fee, times: 1},
        ]
      : []),
  ]
}

function successfulTelegramCalls(userId: number, ownerId: number) {
  return [
    {method: 'approveChatJoinRequest', to: CHAT_GROUP},
    {method: 'sendMessage', to: userId, text: /Access to the community/},
    {method: 'sendMessage', to: ownerId, text: /New subscription payment/},
  ]
}

function expectKeptPayment(
  rows: {before?: unknown; after?: unknown}[],
  payment: SubscriptionPayment,
  expected: Partial<SubscriptionPayment> = {},
): void {
  expect(rows).toHaveLength(1)
  expect(rows[0]?.before).toMatchObject({id: payment.id})
  expect(rows[0]?.after).toMatchObject({
    id: payment.id,
    settleAttempts: payment.settleAttempts + 1,
    settledAt: expect.any(Date),
    ...expected,
  })
}

function seedPendingOutgoing(receiver: FakeWallet, sats: number): FakePayment {
  const incoming = e2e.ln.state.createInvoice({
    wallet: receiver,
    sats,
    memo: 'E2E pending payout',
    expirySec: 24 * 60 * 60,
  })
  e2e.ln.state.payments.push({...incoming, walletId: masterWallet().id, out: true, paid: false})
  return incoming
}

function payPayout(receiver: FakeWallet, sats: number): FakePayment {
  const incoming = e2e.ln.state.createInvoice({
    wallet: receiver,
    sats,
    memo: 'E2E paid payout',
    expirySec: 24 * 60 * 60,
  })
  e2e.ln.state.payInvoice({payerWallet: masterWallet(), bolt11: incoming.bolt11})
  return incoming
}

function expectPayouts(ownerId: number, ownerTimes: number, feeTimes: number): void {
  expectPayoutsExactly(e2e.ln, {
    toWallet: walletName(ownerId),
    sats: OWNER_PAYOUT,
    times: ownerTimes,
  })
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees wallet', sats: FEE, times: feeTimes})
}

function expectAllSettlementPayouts(refundTimes: number): void {
  expectPayouts(OWNER, 1, 1)
  expectPayoutsExactly(e2e.ln, {
    toWallet: walletForUser(USER_A),
    sats: PRICE,
    times: refundTimes,
  })
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

function walletName(userId: number): string {
  return `${userId} wallet`
}

async function requiredPayment(id: string): Promise<SubscriptionPayment> {
  const payment = await e2e.container.payments.findById(id)
  if (!payment) throw new Error(`Subscription payment ${id} not found`)
  return payment
}

async function requiredSubscription(userId = USER_A, chatId = CHAT_GROUP) {
  const subscription = await e2e.container.subscriptions.findByUserAndChat(userId, chatId)
  if (!subscription) throw new Error(`Subscription for ${userId} in ${chatId} not found`)
  return subscription
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

async function recreateWorld(options: Parameters<typeof createE2E>[0]): Promise<void> {
  await e2e.dispose()
  e2e = await createE2E(options)
}
