import {afterEach, beforeEach, expect, test} from 'bun:test'
import {
  expectEditedNotSent,
  expectMessageTo,
  expectNoConversations,
  expectNoErrors,
  expectPayoutsExactly,
  expectWorldUnchanged,
} from './asserts.js'
import {USER_A} from './fixtures/ids.js'
import {seedPendingInvoice, seedUser} from './fixtures/seed.js'
import {createE2E, type E2E} from './harness.js'
import {snapshot} from './state.js'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('message, log, conversation and unchanged-world assertions cover their domains', async () => {
  e2e.tg.calls.push({method: 'sendMessage', payload: {chat_id: USER_A, text: 'hello e2e'}})
  expectMessageTo(e2e.tg, USER_A, /hello/)
  expectNoErrors(e2e.logs)
  await expectNoConversations(e2e.db)
  const before = await snapshot(e2e)
  expectWorldUnchanged(before, await snapshot(e2e))
})

test('expectEditedNotSent requires an edit and rejects a send', () => {
  e2e.tg.calls.push({method: 'editMessageText', payload: {chat_id: USER_A, text: 'edited'}})
  expectEditedNotSent(e2e.tg)

  e2e.tg.calls.push({method: 'sendMessage', payload: {chat_id: USER_A, text: 'extra'}})
  expect(() => expectEditedNotSent(e2e.tg)).toThrow()
})

test('expectPayoutsExactly identifies a paid incoming invoice for the target wallet', async () => {
  await seedUser(e2e)
  const pending = await seedPendingInvoice(e2e, {sats: 21})
  const payment = e2e.ln.state.payments.find(
    candidate => candidate.paymentHash === pending.paymentHash,
  )
  if (!payment) throw new Error('Expected seeded payment')
  payment.paid = true
  e2e.ln.state.credit(payment.walletId, payment.amountMsat)

  expectPayoutsExactly(e2e.ln, {toWallet: `${USER_A} wallet`, sats: 21, times: 1})
  expect(() =>
    expectPayoutsExactly(e2e.ln, {toWallet: `${USER_A} wallet`, sats: 21, times: 2}),
  ).toThrow()
})
