import {afterEach, beforeEach, expect, test} from 'bun:test'
import {
  pendingInvoicesTable,
  subscriptionPaymentsTable,
  subscriptionsTable,
} from '@infra/db/schema.js'
import type {PendingInvoice} from '@infra/db/types.js'
import {expectNoErrors, expectWorldUnchanged} from '../asserts.js'
import type {FakeWallet} from '../fakes/lnbits-state.js'
import {CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {
  seedChat,
  seedExpiringSubscription,
  seedPendingInvoice,
  seedSubscriptionPayment,
  seedUser,
} from '../fixtures/seed.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

/**
 * Cron jobs as batch walkers: empty ticks stay quiet, oversize queues finish, one bad row cannot
 * sink the rest, and the pending-invoice branches (paid / 404 / timeout / failed delete) leave the
 * world in the state the next tick can safely resume from.
 *
 * In-batch row order is UUID/`desc(id)` — never asserted. Default `batchSize` is 10 and is not
 * overridden here, so finishability always uses more than ten rows.
 */

const BATCH_SIZE = 10
const OVER_BATCH = BATCH_SIZE + 2
/** Ceiling on LNbits HTTP traffic for one over-batch walk (wallet setup + one lookup per row). */
const REQUEST_CAP = 200
const EXPIRING_FETCH_CAP = 50
const PENDING_SATS = 21
const PRICE = 1000
const HOUR_MS = 60 * 60 * 1000

const ALL_JOBS = [
  'pendingInvoices',
  'expiredInvoices',
  'subscriptionPayments',
  'expiredSubscriptions',
  'expiringSubscriptions',
] as const

export const COVERS = scenarioCoverage.jobs

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
    languageCode: 'en',
  })
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Empty ticks ---

test('each of the five jobs is a no-op on an empty database', async () => {
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length
  const telegramMark = e2e.tg.calls.length

  for (const name of ALL_JOBS) {
    await expectDelta(e2e, () => e2e.jobs[name](), {})
  }

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  expect(e2e.ln.requests).toHaveLength(requestMark)
  expect(e2e.tg.calls).toHaveLength(telegramMark)
  expectNoErrors(e2e.logs)
})

// --- pending invoices ---

test('a paid pending invoice is notified and deleted', async () => {
  const pending = await seedPendingInvoice(e2e, {sats: PENDING_SATS})
  payPendingInvoice(pending)
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {
      pendingInvoices: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({paymentHash: pending.paymentHash}),
      },
    },
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /You received payment for a Lightning invoice/},
    ],
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(
    new RegExp(`Amount: <b>${PENDING_SATS} sats</b>`),
  )
  expectNoErrors(e2e.logs)
})

test('a pending invoice missing from LNbits is deleted', async () => {
  await seedOrphanPendingInvoice()
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {pendingInvoices: {removed: 1}},
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
  expect(e2e.tg.calls).toEqual([])
  expect(errorMessages().some(message => message.startsWith('Error processing invoice'))).toBe(true)
  expect(errorMessages().some(message => message.includes('not found on LNBits'))).toBe(true)
})

test('a lookup timeout keeps the pending invoice for a later tick', async () => {
  const pending = await seedPendingInvoice(e2e, {sats: PENDING_SATS})
  const originalGetUserWallet = e2e.container.getUserWallet
  e2e.container.getUserWallet = async userId => {
    const wallet = await originalGetUserWallet(userId)
    return Object.assign(wallet, {
      lookupPayment: async () => {
        throw Object.assign(new Error('Injected payment lookup timeout'), {code: 'ETIMEDOUT'})
      },
    })
  }
  const before = await snapshot(e2e)
  const requestMark = e2e.ln.requests.length

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expectLedgerBalanced(before, after)
  // Wallet may still be resolved before the injected throw; no payment lookup is required.
  expect(e2e.ln.requests.length - requestMark).toBeLessThan(REQUEST_CAP)
  expect(await onlyPendingInvoice()).toMatchObject({paymentHash: pending.paymentHash})
  expect(e2e.tg.calls).toEqual([])
  expect(
    e2e.logs.some(
      log =>
        (log.level === 'warn' || log.level === 40) &&
        String(log.msg ?? '').includes(`Timeout checking invoice ${pending.paymentHash}`),
    ),
  ).toBe(true)
})

test('a failed 404 delete keeps the row and still finishes the job', async () => {
  const orphan = await seedOrphanPendingInvoice()
  const originalDelete = e2e.container.invoices.deleteByPaymentRequest.bind(e2e.container.invoices)
  let deleteAttempts = 0
  e2e.container.invoices.deleteByPaymentRequest = async _paymentRequest => {
    deleteAttempts++
    throw new Error('Injected pending-invoice delete failure')
  }
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(deleteAttempts).toBe(1)
  expect(await onlyPendingInvoice()).toMatchObject({
    paymentRequest: orphan.paymentRequest,
    paymentHash: orphan.paymentHash,
  })
  expect(e2e.tg.calls).toEqual([])
  expect(
    errorMessages().some(message => message.includes('Failed to delete not-found invoice')),
  ).toBe(true)

  // Restore delete so a second tick proves the job is still finishable and can clean up.
  e2e.container.invoices.deleteByPaymentRequest = originalDelete
  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {pendingInvoices: {removed: 1}},
  })
  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
})

test('one failing pending invoice does not block the rest of the batch', async () => {
  const goodA = await seedPendingInvoice(e2e, {sats: PENDING_SATS})
  const bad = await seedPendingInvoice(e2e, {sats: PENDING_SATS + 1})
  const goodB = await seedPendingInvoice(e2e, {sats: PENDING_SATS + 2})
  payPendingInvoice(goodA)
  payPendingInvoice(goodB)

  // Throw inside the wallet client so got cannot retry a 500 for ~3s per attempt.
  const originalGetUserWallet = e2e.container.getUserWallet
  e2e.container.getUserWallet = async userId => {
    const wallet = await originalGetUserWallet(userId)
    const lookupPayment = wallet.lookupPayment.bind(wallet)
    return Object.assign(wallet, {
      lookupPayment: async (paymentHash: string) => {
        if (paymentHash === bad.paymentHash) {
          throw new Error(`Injected lookup failure for ${paymentHash}`)
        }
        return lookupPayment(paymentHash)
      },
    })
  }

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {pendingInvoices: {removed: 2}},
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /You received payment for a Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /You received payment for a Lightning invoice/},
    ],
  })

  const remaining = await e2e.db.select().from(pendingInvoicesTable)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.paymentHash).toBe(bad.paymentHash)
  expect(errorMessages().some(message => message.includes(bad.paymentHash))).toBe(true)
})

test('pending invoices finishes with more than one batch of unpaid rows', async () => {
  for (let index = 0; index < OVER_BATCH; index++) {
    await seedPendingInvoice(e2e, {sats: PENDING_SATS + index})
  }
  const requestMark = e2e.ln.requests.length
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(e2e.ln.requests.length - requestMark).toBeLessThan(REQUEST_CAP)
  expect(e2e.ln.requests.length - requestMark).toBeGreaterThanOrEqual(OVER_BATCH)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toHaveLength(OVER_BATCH)
  expectNoErrors(e2e.logs)
})

// --- delete-expired-invoices ---

test('delete-expired-invoices removes only past-due rows', async () => {
  const expired = await seedPendingInvoice(e2e, {
    sats: PENDING_SATS,
    expiresAt: new Date(Date.now() - HOUR_MS),
  })
  const live = await seedPendingInvoice(e2e, {
    sats: PENDING_SATS + 1,
    expiresInMs: HOUR_MS,
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.expiredInvoices(), {
    db: {
      pendingInvoices: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({paymentHash: expired.paymentHash}),
      },
    },
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await onlyPendingInvoice()).toMatchObject({paymentHash: live.paymentHash})
  expectNoErrors(e2e.logs)
})

// --- finishability for the other batch jobs ---

test('subscription payments finishes with more than one batch of unpaid rows', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  for (let index = 0; index < OVER_BATCH; index++) {
    const userId = 200_000 + index
    await seedUser(e2e, {id: userId, username: `pay_user_${index}`, firstName: `Pay ${index}`})
    await seedSubscriptionPayment(e2e, {
      userId,
      chatId: CHAT_GROUP,
      paid: false,
      price: PRICE,
      subscriptionType: 'monthly',
      kind: 'renewal',
    })
  }
  const requestMark = e2e.ln.requests.length
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(e2e.ln.requests.length - requestMark).toBeLessThan(REQUEST_CAP)
  expect(e2e.ln.requests.length - requestMark).toBeGreaterThanOrEqual(OVER_BATCH)
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toHaveLength(OVER_BATCH)
  expectNoErrors(e2e.logs)
})

test('expired subscriptions finishes with more than one batch of rows', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  for (let index = 0; index < OVER_BATCH; index++) {
    const userId = 210_000 + index
    await seedUser(e2e, {id: userId, username: `exp_user_${index}`, firstName: `Exp ${index}`})
    await seedExpiringSubscription(e2e, {
      userId,
      chatId: CHAT_GROUP,
      price: PRICE,
      endsInMs: -HOUR_MS,
    })
  }
  const telegramMark = e2e.tg.calls.length
  const before = await snapshot(e2e)

  // Telegram order follows UUID-desc; only the volume and methods are fixed.
  const expiryCalls = Array.from({length: OVER_BATCH}, () => [
    {method: 'banChatMember', to: CHAT_GROUP},
    {method: 'unbanChatMember', to: CHAT_GROUP},
  ]).flat()

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {subscriptions: {removed: OVER_BATCH}},
    telegram: expiryCalls,
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.select().from(subscriptionsTable)).toEqual([])
  expect(e2e.tg.calls.length - telegramMark).toBe(OVER_BATCH * 2)
  expectNoErrors(e2e.logs)
})

test('expiring subscriptions finishes when every row is handed off to settle', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  for (let index = 0; index < OVER_BATCH; index++) {
    const userId = 220_000 + index
    await seedUser(e2e, {id: userId, username: `ren_user_${index}`, firstName: `Ren ${index}`})
    await seedExpiringSubscription(e2e, {
      userId,
      chatId: CHAT_GROUP,
      price: PRICE,
      autoRenew: true,
      endsInMs: HOUR_MS,
    })
    await seedSubscriptionPayment(e2e, {
      userId,
      chatId: CHAT_GROUP,
      paid: false,
      price: PRICE,
      subscriptionType: 'monthly',
      kind: 'renewal',
    })
  }
  const requestMark = e2e.ln.requests.length
  const before = await snapshot(e2e)
  const expiringFetches = capExpiringSubscriptionFetch()

  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {})

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(expiringFetches()).toBeLessThanOrEqual(EXPIRING_FETCH_CAP)
  expect(e2e.ln.requests.length - requestMark).toBeLessThan(REQUEST_CAP)
  expect(await e2e.db.select().from(subscriptionsTable)).toHaveLength(OVER_BATCH)
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toHaveLength(OVER_BATCH)
  expect(e2e.tg.calls).toEqual([])
  expect(
    infoMessages().filter(message =>
      message.includes('Renewal handed off to the subscription payment settle path.'),
    ),
  ).toHaveLength(OVER_BATCH)
  expectNoErrors(e2e.logs)
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

// --- isolation between consecutive jobs ---

test('two jobs in a row leave a mixed world consistent', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  const expiredInvoice = await seedPendingInvoice(e2e, {
    sats: PENDING_SATS,
    expiresAt: new Date(Date.now() - HOUR_MS),
  })
  const liveInvoice = await seedPendingInvoice(e2e, {
    sats: PENDING_SATS + 1,
    expiresInMs: HOUR_MS,
  })
  payPendingInvoice(liveInvoice)
  const expiredSub = await seedExpiringSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsInMs: -HOUR_MS,
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  const unpaidPayment = await seedSubscriptionPayment(e2e, {
    userId: USER_B,
    chatId: CHAT_GROUP,
    paid: false,
    price: PRICE,
    subscriptionType: 'one_time',
    kind: 'join',
  })

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {
      pendingInvoices: {
        removed: 1,
        match: rows =>
          expect(rows[0]?.before).toMatchObject({paymentHash: liveInvoice.paymentHash}),
      },
    },
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /You received payment for a Lightning invoice/},
    ],
  })

  await expectDelta(e2e, () => e2e.jobs.expiredInvoices(), {
    db: {
      pendingInvoices: {
        removed: 1,
        match: rows =>
          expect(rows[0]?.before).toMatchObject({paymentHash: expiredInvoice.paymentHash}),
      },
    },
  })

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {})

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: expiredSub.id}),
      },
    },
    telegram: [
      {method: 'banChatMember', to: CHAT_GROUP},
      {method: 'unbanChatMember', to: CHAT_GROUP},
    ],
  })

  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
  expect(await e2e.db.select().from(subscriptionsTable)).toEqual([])
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([
    expect.objectContaining({id: unpaidPayment.id, paymentHash: unpaidPayment.paymentHash}),
  ])
  expectNoErrors(e2e.logs)
})

test('subscription payments deletes an expired unpaid invoice once', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  const payment = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: false,
    price: PRICE,
    expiresInMs: -HOUR_MS,
    subscriptionType: 'monthly',
    kind: 'renewal',
  })
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: payment.id}),
      },
    },
  })

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expect(await e2e.db.select().from(subscriptionPaymentsTable)).toEqual([])
  expect(infoMessages().some(message => message.includes('Subscription payment expired.'))).toBe(
    true,
  )
  expectNoErrors(e2e.logs)
})

test('one throwing expired-subscription row does not stop the rest of the batch', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', paymentType: 'monthly'})
  const keep = await seedExpiringSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsInMs: -HOUR_MS,
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  const remove = await seedExpiringSubscription(e2e, {
    userId: USER_B,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsInMs: -HOUR_MS,
  })

  const originalDelete = e2e.container.subscriptions.delete.bind(e2e.container.subscriptions)
  e2e.container.subscriptions.delete = async (id, endsAt) => {
    if (id === keep.id) throw new Error('Injected subscription delete failure')
    return originalDelete(id, endsAt)
  }

  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {
      subscriptions: {
        removed: 1,
        match: rows => expect(rows[0]?.before).toMatchObject({id: remove.id}),
      },
    },
    telegram: [
      {method: 'banChatMember', to: CHAT_GROUP},
      {method: 'unbanChatMember', to: CHAT_GROUP},
      {method: 'banChatMember', to: CHAT_GROUP},
      {method: 'unbanChatMember', to: CHAT_GROUP},
    ],
  })

  const remaining = await e2e.db.select().from(subscriptionsTable)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.id).toBe(keep.id)
  expect(errorMessages().some(message => message.includes('Error processing item'))).toBe(true)
})

// --- helpers ---

async function seedOrphanPendingInvoice(): Promise<PendingInvoice> {
  const paymentHash = 'ab'.repeat(32)
  return e2e.container.invoices.create({
    userId: USER_A,
    paymentRequest: `lnbc-orphan-${paymentHash}`,
    paymentHash,
    expiresAt: new Date(Date.now() + HOUR_MS),
  })
}

function payPendingInvoice(pending: PendingInvoice): void {
  const payer = walletFor(USER_B)
  e2e.ln.state.credit(payer.id, PENDING_SATS * 1000 + 50_000)
  e2e.ln.state.payInvoice({payerWallet: payer, bolt11: pending.paymentRequest})
}

function walletFor(userId: number): FakeWallet {
  const user = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet
}

async function onlyPendingInvoice(): Promise<PendingInvoice> {
  const rows = await e2e.db.select().from(pendingInvoicesTable)
  expect(rows).toHaveLength(1)
  const row = rows[0]
  if (!row) throw new Error('Expected one pending invoice')
  return row
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function infoMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'info' || log.level === 30)
    .map(log => String(log.msg ?? ''))
}
