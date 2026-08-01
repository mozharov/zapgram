import {expect, mock, test} from 'bun:test'

/**
 * Guard against the non-terminating batch.
 *
 * runBatch only advances `offset` past items reported as `keep`. A `handed_off` renewal changes
 * nothing about the subscription, so the row still matches the expiring-window query — reporting
 * `done` for it makes the next fetch return the same row forever. With `waitForCompletion: true`
 * that wedges the cron job permanently and auto-renewal stops for everyone.
 */

const quiet = {error() {}, info() {}, warn() {}, debug() {}, child: () => quiet}

const subscription = {
  id: 'sub-1',
  userId: 1,
  chatId: -100,
  price: 1000,
  endsAt: new Date(Date.now() + 60 * 60 * 1000),
  autoRenew: true,
  notificationSent: false,
  createdAt: new Date(),
}

let renewalOutcome: {status: 'renewed' | 'handed_off' | 'failed'} = {status: 'handed_off'}
let fetchCalls = 0
let offsets: number[] = []
/**
 * Models the real query: a renewed subscription has its endsAt pushed past the threshold, and a
 * failed one gets notificationSent, so both drop out of the window. A handed-off one does not.
 */
let leftWindow = false
const invoicesSent: string[] = []
const updates: unknown[] = []

const FETCH_CAP = 50

mock.module('../../../runtime.js', () => ({getRuntime: () => ({log: quiet})}))
mock.module('@modules/users/repository.js', () => ({
  getUserOrThrow: async () => ({id: 1, languageCode: 'en'}),
}))
mock.module('@modules/chats/repository.js', () => ({
  getChatOrThrow: async () => ({id: -100, title: 'C', price: 1000, ownerId: 2, owner: {}}),
}))
mock.module('@modules/subscriptions/renewal.js', () => ({
  renewalService: {
    attemptAutoRenewal: async () => {
      if (renewalOutcome.status === 'renewed') leftWindow = true
      return renewalOutcome
    },
    createAndSendRenewalInvoice: async () => {
      invoicesSent.push('sent')
    },
  },
}))
mock.module('@modules/subscriptions/repository.js', () => ({
  countSubscriptionsExpiringWithin: async () => 1,
  getSubscriptionsExpiringWithin: async (
    _max: Date,
    _min: Date,
    _limit: number,
    offset: number,
  ) => {
    fetchCalls++
    offsets.push(offset)
    if (fetchCalls > FETCH_CAP) throw new Error('runBatch did not terminate')
    return !leftWindow && offset === 0 ? [subscription] : []
  },
  updateSubscription: async (id: string, data: unknown) => {
    updates.push({id, data})
    leftWindow = true
  },
}))

const {processExpiringSubscriptions} = await import(
  '@modules/subscriptions/jobs/process-expiring-subscriptions.js'
)

function reset(outcome: typeof renewalOutcome) {
  renewalOutcome = outcome
  leftWindow = false
  fetchCalls = 0
  offsets = []
  invoicesSent.length = 0
  updates.length = 0
}

test('a handed-off renewal terminates the batch instead of refetching forever', async () => {
  reset({status: 'handed_off'})
  await processExpiringSubscriptions()
  expect(fetchCalls).toBeLessThanOrEqual(FETCH_CAP)
  expect(offsets).toEqual([0, 1])
})

test('a failed renewal sends the manual invoice and marks the notification', async () => {
  reset({status: 'failed'})
  await processExpiringSubscriptions()
  expect(invoicesSent).toEqual(['sent'])
  expect(updates).toEqual([{id: 'sub-1', data: {notificationSent: true}}])
  expect(fetchCalls).toBeLessThanOrEqual(FETCH_CAP)
})

test('a completed renewal sends nothing extra — settle already notified', async () => {
  reset({status: 'renewed'})
  await processExpiringSubscriptions()
  expect(invoicesSent).toEqual([])
  expect(updates).toEqual([])
  expect(fetchCalls).toBeLessThanOrEqual(FETCH_CAP)
})
