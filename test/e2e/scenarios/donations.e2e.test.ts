import {afterEach, beforeEach, expect, test} from 'bun:test'
import {processMonthlyDonations} from '@modules/donations/jobs/process-monthly-donations.js'
import {
  donateAmountRoute,
  donateMonthlyAmountRoute,
  donationPercentRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {groupText, privateCallback, privateCommand} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.donations

const STARTING = 100_000
const FEES = 'fees wallet'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('/donate hub shows stats and external lightning address', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await e2e.send(privateCommand('/donate'))

  const messages = e2e.tg.of('sendMessage').map(c => String(c.text))
  expect(messages.some(t => t.includes('zapgram@getalby.com'))).toBe(true)
  expect(messages.some(t => /ZapPlanner/i.test(t))).toBe(false)
  expect(messages.some(t => /Community|🌍/i.test(t))).toBe(true)
  expect(messages.some(t => /All time:.*0/i.test(t) && /Last 30 days:.*0/i.test(t))).toBe(true)
  expect(messages.some(t => /Auto on payments/i.test(t))).toBe(true)
  expectNoErrors(e2e.logs)
})

test('one-shot donate 1000 credits fee wallet and updates stats', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  credit(USER_A, STARTING)

  const before = await snapshot(e2e)
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(donateAmountRoute.build({amountSats: 1000}))),
    {
      db: {
        donations: {added: 1},
        donationPlatformStats: {changed: 1},
      },
      lnbits: {
        balances: {
          '100001 wallet': -1000,
          [FEES]: 1000,
        },
        payments: [
          {out: false, sats: 1000, times: 1},
          {out: true, sats: 1000, times: 1},
        ],
      },
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'deleteMessage'},
        {method: 'sendChatAction', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Thanks! You sent 1,?000 sats/},
        {method: 'sendMessage', to: USER_A, text: /Support ZapGram|All time/},
      ],
    },
  )
  expectLedgerBalanced(before, await snapshot(e2e))

  const stats = await e2e.container.donations.getUserStats(USER_A)
  expect(stats.totalSats).toBe(1000)
  expect(stats.count).toBe(1)
  const platform = await e2e.container.donations.getPlatformStats()
  expect(platform.totalSats).toBe(1000)
  expect(platform.lastMonthSats).toBe(1000)
  expectNoErrors(e2e.logs)
})

test('tip with 5% donation charges tip + donation without success PM about donation', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 5,
    donationScope: 'all',
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, STARTING)

  const tipSats = 100
  const donationSats = 5
  const before = await snapshot(e2e)

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        groupText(`/tip ${tipSats} @user_b`, {
          from: {id: USER_A, username: 'user_a', first_name: 'User A'},
        }),
      ),
    {
      db: {
        donations: {added: 1},
        donationPlatformStats: {changed: 1},
      },
      lnbits: {
        balances: {
          '100001 wallet': -(tipSats + donationSats),
          '100002 wallet': tipSats,
          [FEES]: donationSats,
        },
        payments: [
          {out: false, sats: tipSats, times: 1},
          {out: true, sats: tipSats, times: 1},
          {out: false, sats: donationSats, times: 1},
          {out: true, sats: donationSats, times: 1},
        ],
      },
      telegram: [
        {method: 'deleteMessage'},
        {method: 'sendChatAction'},
        {method: 'sendMessage', text: /sent 100 sats to @user_b/},
        {method: 'sendMessage', to: USER_B, text: /You received 100 sats/},
      ],
    },
  )

  expectLedgerBalanced(before, await snapshot(e2e))
  const pms = e2e.tg
    .of('sendMessage')
    .filter(c => Number(c.chat_id) === USER_A)
    .map(c => String(c.text))
  expect(pms.some(t => /support tip/i.test(t) || /optional/i.test(t))).toBe(false)
  expectNoErrors(e2e.logs)
})

test('settings can set donation percent to 0', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 5,
  })
  await e2e.send(privateCallback(staticCallback.donationSettings))
  await e2e.send(privateCallback(donationPercentRoute.build({percent: 0})))

  const user = await e2e.container.users.findById(USER_A)
  expect(user?.donationPercent).toBe(0)
  expectNoErrors(e2e.logs)
})

test('monthly enable charges immediately and advances nextAt', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  credit(USER_A, STARTING)

  const before = await snapshot(e2e)
  await e2e.send(privateCallback(staticCallback.donateMonthlyMenu))
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 100}))),
    {
      db: {
        donations: {added: 1},
        users: {changed: 1},
        donationPlatformStats: {changed: 1},
      },
      lnbits: {
        balances: {
          '100001 wallet': -100,
          [FEES]: 100,
        },
        payments: [
          {out: false, sats: 100, times: 1},
          {out: true, sats: 100, times: 1},
        ],
      },
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'deleteMessage'},
        {method: 'sendChatAction', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Monthly donation set to 100 sats/},
        {method: 'sendMessage', to: USER_A, text: /zapgram@getalby.com|Support ZapGram/},
      ],
    },
  )
  expectLedgerBalanced(before, await snapshot(e2e))

  const user = await e2e.container.users.findById(USER_A)
  expect(user?.monthlyDonationSats).toBe(100)
  expect(user?.monthlyDonationNextAt).toBeInstanceOf(Date)
  const next = user?.monthlyDonationNextAt?.getTime() ?? 0
  const approx30d = 30 * 24 * 60 * 60 * 1000
  expect(Math.abs(next - (Date.now() + approx30d))).toBeLessThan(60_000)
  expectNoErrors(e2e.logs)
})

test('monthly job charges when nextAt is due', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 0,
    monthlyDonationSats: 50,
    monthlyDonationNextAt: new Date(Date.now() - 1000),
  })
  credit(USER_A, STARTING)

  const before = await snapshot(e2e)
  await processMonthlyDonations(new Date())
  const after = await snapshot(e2e)

  expect(after.db.donations.length - before.db.donations.length).toBe(1)
  const feesBefore = before.lnbits.wallets.find(w => w.name === FEES)?.balanceMsat ?? 0
  const feesAfter = after.lnbits.wallets.find(w => w.name === FEES)?.balanceMsat ?? 0
  expect((feesAfter - feesBefore) / 1000).toBe(50)
  const platformBefore = before.db.donationPlatformStats[0]?.totalSats ?? 0
  const platformAfter = after.db.donationPlatformStats[0]?.totalSats ?? 0
  expect(platformAfter - platformBefore).toBe(50)

  const user = await e2e.container.users.findById(USER_A)
  expect(user?.monthlyDonationNextAt && user.monthlyDonationNextAt > new Date()).toBe(true)
  expectLedgerBalanced(before, after)
  expectNoErrors(e2e.logs)
})

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}
