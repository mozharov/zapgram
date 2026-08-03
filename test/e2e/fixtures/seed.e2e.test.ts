import {afterEach, beforeEach, expect, test} from 'bun:test'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, snapshot} from '../state.js'
import {CHAT_GROUP, OWNER, USER_A} from './ids.js'
import {
  seedActivePaidChat,
  seedChat,
  seedExpiringSubscription,
  seedPendingInvoice,
  seedSubscription,
  seedSubscriptionPayment,
  seedUser,
} from './seed.js'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('seedUser uses the real repository and creates exactly one fake LNbits wallet', async () => {
  await expectDelta(
    e2e,
    async () => {
      await seedUser(e2e)
    },
    {
      db: {users: {added: 1}},
      lnbits: {balances: {[`${USER_A} wallet`]: 0}},
    },
  )

  const world = await snapshot(e2e)
  expect(world.db.users[0]?.nwcUrl).toBeNull()
})

test('seedChat and seedActivePaidChat only add their requested chat rows', async () => {
  await seedUser(e2e, {id: OWNER})
  await expectDelta(
    e2e,
    async () => {
      await seedChat(e2e)
    },
    {db: {chats: {added: 1}}},
  )
  await expectDelta(
    e2e,
    async () => {
      await seedActivePaidChat(e2e, {id: CHAT_GROUP - 1, title: 'Second chat'})
    },
    {db: {chats: {added: 1}}},
  )

  const world = await snapshot(e2e)
  expect(world.db.chats.find(chat => chat.id === CHAT_GROUP)?.status).toBe('inactive')
  expect(world.db.chats.find(chat => chat.id === CHAT_GROUP - 1)?.status).toBe('active')
})

test('subscription seed helpers use relative expiry and add no extra rows', async () => {
  await seedUser(e2e, {id: OWNER})
  await seedUser(e2e)
  await seedActivePaidChat(e2e)
  await seedActivePaidChat(e2e, {id: CHAT_GROUP - 1})
  await expectDelta(
    e2e,
    async () => {
      await seedSubscription(e2e)
    },
    {
      db: {subscriptions: {added: 1}},
    },
  )
  await expectDelta(
    e2e,
    async () => {
      await seedExpiringSubscription(e2e, {
        chatId: CHAT_GROUP - 1,
        userId: USER_A,
        endsInMs: 30_000,
      })
    },
    {db: {subscriptions: {added: 1}}},
  )

  const subscriptions = (await snapshot(e2e)).db.subscriptions
  expect(subscriptions.some(subscription => subscription.endsAt instanceof Date)).toBe(true)
})

test('seedSubscriptionPayment synchronizes paid state with the fake ledger', async () => {
  await seedUser(e2e, {id: OWNER})
  await seedUser(e2e)
  await seedActivePaidChat(e2e)

  await expectDelta(
    e2e,
    async () => {
      await seedSubscriptionPayment(e2e, {paid: true, price: 1000})
    },
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {added: 1},
      },
      lnbits: {
        balances: {'master wallet': 1000},
        payments: [
          {out: false, sats: 1000, times: 1},
          {out: true, sats: 1000, times: 1},
        ],
      },
    },
  )

  const world = await snapshot(e2e)
  expect(world.lnbits.payments.every(payment => payment.paid)).toBe(true)
})

test('seedPendingInvoice adds one DB row and one unpaid fake invoice', async () => {
  await seedUser(e2e)
  await expectDelta(
    e2e,
    async () => {
      await seedPendingInvoice(e2e, {sats: 21})
    },
    {
      db: {pendingInvoices: {added: 1}},
      lnbits: {payments: [{out: false, sats: 21, times: 1}]},
    },
  )

  expect((await snapshot(e2e)).lnbits.payments[0]?.paid).toBe(false)
})
