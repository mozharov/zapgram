import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test'
import {processMonthlyDonations} from '@modules/donations/jobs/process-monthly-donations.js'
import {reconcilePendingDonations} from '@modules/donations/jobs/reconcile-pending-donations.js'
import {
  donateAmountRoute,
  donateMonthlyAmountRoute,
  donationPercentRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {expectNoConversations, expectNoErrors} from '../asserts.js'
import {USER_A, USER_B} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {groupText, privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
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

  const hub = e2e.tg.last('sendRichMessage')
  const html = richHtmlOf(hub)
  expect(html).toContain('zapgram@getalby.com')
  expect(html).not.toMatch(/ZapPlanner/i)
  expect(html).toMatch(/<h1>[\s\S]*Support ZapGram/)
  expect(html).toMatch(/<details open><summary>🌍 Community impact/u)
  expect(html).toMatch(/All time:[\s\S]*0[\s\S]*Last 30 days:[\s\S]*0/)
  expect(html).toMatch(/Auto support:[\s\S]*Off[\s\S]*tips \+ invoices/)
  expectNoErrors(e2e.logs)
})

test('/donate hub keeps the rich structure in Russian', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await e2e.send(
    privateCommand('/donate', {
      from: {id: USER_A, username: 'user_a', language_code: 'ru'},
    }),
  )

  const html = richHtmlOf(e2e.tg.last('sendRichMessage'))
  expect(html).toMatch(/<h1>💚 Поддержать ZapGram/u)
  expect(html).toMatch(/<details open><summary>🌍 Вклад сообщества/u)
  expect(html).toMatch(/<details open><summary>👤 Твоя поддержка/u)
  expect(html).toContain('Последний донат:')
  expect(html).toContain('zapgram@getalby.com')
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
        {method: 'sendRichMessage', to: USER_A, text: /Support ZapGram|All time/},
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
        {method: 'sendRichMessage', to: USER_A, text: /zapgram@getalby.com|Support ZapGram/},
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
  expect(user?.monthlyDonationLastHash).toBeNull()
  expect(user?.monthlyDonationExpiresAt).toBeNull()
  await processMonthlyDonations(new Date())
  expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(1)
  expect((await e2e.container.users.getOrThrow(USER_A)).monthlyDonationNextAt).toEqual(
    user?.monthlyDonationNextAt ?? null,
  )
  expectDonationLegs(1, 1)
  expectNoErrors(e2e.logs)
})

test('custom one-shot retries invalid amount without paying, then accepts valid input', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  credit(USER_A, STARTING)

  await e2e.send(privateCallback(staticCallback.donateCustom))
  const promptMessageId = requiredPromptMessageId()
  const beforeInvalid = await snapshot(e2e)

  await e2e.send(privateText('not sats'))

  const afterInvalid = await snapshot(e2e)
  expect(afterInvalid.db.donations).toEqual(beforeInvalid.db.donations)
  expect(afterInvalid.db.donationPlatformStats).toEqual(beforeInvalid.db.donationPlatformStats)
  expect(afterInvalid.lnbits).toEqual(beforeInvalid.lnbits)
  expect(afterInvalid.db.conversations).toHaveLength(1)
  expect(e2e.tg.lastMessageId('sendMessage')).not.toBe(promptMessageId)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/whole number|целое число/i)

  const input = privateText('125')
  await e2e.send(input)

  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(125)
  expectDeletedMessage(input.message?.message_id)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('custom donation percent retries invalid value before updating settings', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 5,
  })

  await e2e.send(privateCallback(staticCallback.donationCustomPercent))
  await e2e.send(privateText('101'))

  expect((await e2e.container.users.findById(USER_A))?.donationPercent).toBe(5)
  expect((await snapshot(e2e)).db.conversations).toHaveLength(1)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/between 0 and 100|от 0 до 100/i)

  const input = privateText('7')
  await e2e.send(input)

  expect((await e2e.container.users.findById(USER_A))?.donationPercent).toBe(7)
  expectDeletedMessage(input.message?.message_id)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('custom monthly amount charges and deletes the entered amount after success', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  credit(USER_A, STARTING)

  await e2e.send(privateCallback(staticCallback.donateMonthlyCustom))
  const input = privateText('100')
  await e2e.send(input)

  const user = await e2e.container.users.getOrThrow(USER_A)
  expect(user.monthlyDonationSats).toBe(100)
  expect(
    Math.abs((user.monthlyDonationNextAt?.getTime() ?? 0) - Date.now() - 30 * 24 * 60 * 60 * 1000),
  ).toBeLessThan(60_000)
  expect(user.monthlyDonationLastHash).toBeNull()
  expect(user.monthlyDonationExpiresAt).toBeNull()
  expectDeletedMessage(input.message?.message_id)
  await expectNoConversations(e2e.db)
  await processMonthlyDonations(new Date())
  expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(1)
  expect((await e2e.container.users.getOrThrow(USER_A)).monthlyDonationNextAt).toEqual(
    user.monthlyDonationNextAt,
  )
  expectDonationLegs(1, 1)
  expectNoErrors(e2e.logs)
})

test('custom monthly amount stays active after invalid input and cancel returns to donation hub', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})

  await e2e.send(privateCallback(staticCallback.donateMonthlyCustom))
  const promptMessageId = requiredPromptMessageId()
  const beforeInvalid = await snapshot(e2e)
  await e2e.send(privateText('0'))

  const afterInvalid = await snapshot(e2e)
  expect(afterInvalid.db.donations).toEqual(beforeInvalid.db.donations)
  expect(afterInvalid.lnbits).toEqual(beforeInvalid.lnbits)
  expect(afterInvalid.db.conversations).toHaveLength(1)

  await e2e.send(privateCallback(staticCallback.cancel, {messageId: promptMessageId}))

  await expectNoConversations(e2e.db)
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Action canceled|Действие отменено/i)
  expect(richHtmlOf(e2e.tg.last('sendRichMessage'))).toMatch(/Support ZapGram|Поддержать ZapGram/i)
  expect((await e2e.container.users.findById(USER_A))?.monthlyDonationSats).toBe(0)
  expectNoErrors(e2e.logs)
})

test('/wallet interrupts custom donation without opening donation hub', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})

  await e2e.send(privateCallback(staticCallback.donateCustom))
  await e2e.send(privateCommand('/wallet'))

  await expectNoConversations(e2e.db)
  expect(String(e2e.tg.of('editMessageText').at(-1)?.text)).toMatch(
    /Action canceled|Действие отменено/i,
  )
  const newMessages = e2e.tg.of('sendMessage').map(call => String(call.text))
  expect(newMessages.filter(text => /Support ZapGram|Поддержать ZapGram/i.test(text))).toHaveLength(
    0,
  )
  expect(e2e.tg.of('sendRichMessage').some(call => /Wallet|Кошелёк/i.test(richHtmlOf(call)))).toBe(
    true,
  )
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
  expect(user?.monthlyDonationLastHash).toBeNull()
  expect(user?.monthlyDonationExpiresAt).toBeNull()
  await processMonthlyDonations(new Date())
  expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(1)
  expectDonationLegs(1, 1)
  expectLedgerBalanced(before, after)
  expectNoErrors(e2e.logs)
})

for (const outcome of ['paid', 'failed', '404'] as const) {
  test(`disabled monthly donation reconciles a later ${outcome} without another charge`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    e2e.ln.state.pendingNextPay = true
    await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 100})))
    const pending = await e2e.container.users.getOrThrow(USER_A)
    const hash = pending.monthlyDonationLastHash
    if (!hash) throw new Error('Expected a pending monthly payment')
    expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(0)
    // The intentional uncertain pay logs this error; reconciliation itself must log no errors.
    expect(
      e2e.logs.filter(log => log.level === 'error' || log.level === 50).map(log => log.msg),
    ).toEqual(['Internal donation pay failed'])
    const logsAfterPending = e2e.logs.length

    await e2e.send(privateCallback(staticCallback.donateMonthlyDisable))
    expect(await e2e.container.users.getOrThrow(USER_A)).toMatchObject({
      monthlyDonationSats: 0,
      monthlyDonationNextAt: null,
      monthlyDonationLastHash: hash,
    })
    expect((await e2e.container.users.getOrThrow(USER_A)).monthlyDonationExpiresAt).toEqual(
      pending.monthlyDonationExpiresAt,
    )
    const invoiceCount = e2e.ln.state.payments.length
    await processMonthlyDonations()
    expect((await e2e.container.users.getOrThrow(USER_A)).monthlyDonationLastHash).toBe(hash)

    // Enable must wait for reconciliation, including when the subscription is off.
    await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 200})))
    expect(await e2e.container.users.getOrThrow(USER_A)).toMatchObject({
      monthlyDonationSats: 0,
      monthlyDonationNextAt: null,
      monthlyDonationLastHash: hash,
    })
    expect(
      e2e.tg
        .of('sendMessage')
        .some(call => /previous payment is awaiting confirmation/.test(String(call.text))),
    ).toBe(true)
    expect(e2e.ln.state.payments).toHaveLength(invoiceCount)

    const lookupPath = `/api/v1/payments/${hash}`
    if (outcome === 'paid') {
      for (const payment of e2e.ln.state.payments.filter(row => row.paymentHash === hash)) {
        payment.paid = true
      }
    } else {
      e2e.ln.state.failAlways(
        {method: 'GET', path: lookupPath},
        {
          status: outcome === '404' ? 404 : 200,
          body:
            outcome === '404'
              ? {detail: 'Payment not found.'}
              : {
                  ...(await e2e.container.masterWallet.lookupFeePayment(hash)),
                  paid: false,
                  status: 'failed',
                },
        },
      )
    }
    await processMonthlyDonations()
    await processMonthlyDonations()
    expect(await e2e.container.users.getOrThrow(USER_A)).toMatchObject({
      monthlyDonationSats: 0,
      monthlyDonationNextAt: null,
      monthlyDonationLastHash: null,
    })
    const stats = await e2e.container.donations.getUserStats(USER_A)
    expect(stats.count).toBe(outcome === 'paid' ? 1 : 0)
    expect(stats.totalSats).toBe(outcome === 'paid' ? 100 : 0)
    if (outcome === 'paid') {
      expect(await e2e.container.donations.findByPaymentHash(hash)).toMatchObject({
        userId: USER_A,
        amountSats: 100,
        kind: 'monthly',
        paymentHash: hash,
      })
    }
    expect(e2e.ln.state.payments).toHaveLength(invoiceCount)
    // One donor debit and one fee invoice; owner payouts and duplicate refunds stay at zero.
    const outgoing = e2e.ln.state.payments.filter(payment => payment.out)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]).toMatchObject({paymentHash: hash, amountMsat: 100_000})
    const incoming = e2e.ln.state.payments.filter(payment => !payment.out)
    expect(incoming).toHaveLength(1)
    expect(incoming[0]).toMatchObject({paymentHash: hash, amountMsat: 100_000})
    const reconciliationErrors = e2e.logs
      .slice(logsAfterPending)
      .filter(log => log.level === 'error' || log.level === 50)
    // A 404 is a definitive miss: cron may log the HTTP lookup, but must not emit other errors.
    expect(reconciliationErrors.every(log => outcome === '404' && log.statusCode === 404)).toBe(
      true,
    )
  })
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function requiredPromptMessageId(): number {
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound prompt message ID')
  return messageId
}

function expectDeletedMessage(messageId: number | undefined): void {
  if (messageId === undefined) throw new Error('Expected an input message ID')
  expect(e2e.tg.of('deleteMessage').some(call => Number(call.message_id) === messageId)).toBe(true)
}

function richHtmlOf(payload: Record<string, unknown> | undefined): string {
  const richMessage = payload?.rich_message
  if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
  return String(Reflect.get(richMessage, 'html') ?? '')
}

for (const mode of ['preset', 'custom'] as const) {
  test(`${mode} one-shot retry reconciles its pending invoice before any new charge`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    const donate = async (amount: number) => {
      if (mode === 'preset')
        await e2e.send(privateCallback(donateAmountRoute.build({amountSats: amount})))
      else {
        await e2e.send(privateCallback(staticCallback.donateCustom))
        await e2e.send(privateText(String(amount)))
      }
    }
    e2e.ln.state.pendingNextPay = true
    await donate(50)
    const [pending] = await e2e.container.donations.listPending(USER_A, 'one_shot')
    if (!pending) throw new Error('Expected pending one-shot')
    expect(pending).toMatchObject({amountSats: 50, kind: 'one_shot'})
    expect(pending.expiresAt > new Date()).toBe(true)
    const creation = e2e.ln.requests.find(
      r => r.method === 'POST' && (r.body as {out?: boolean})?.out === false,
    )
    expect((creation?.body as {expiry?: number})?.expiry).toBe(24 * 60 * 60)
    await donate(100)
    expect(e2e.ln.state.payments).toHaveLength(2)
    expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(0)
    expect(
      e2e.tg
        .of('sendMessage')
        .some(call => /50 sats.*awaiting confirmation/.test(String(call.text))),
    ).toBe(true)

    settleDonation(pending.paymentHash)
    await donate(100)
    expect(await e2e.container.donations.listPending()).toHaveLength(0)
    expect(await e2e.container.donations.getUserStats(USER_A)).toMatchObject({
      count: 1,
      totalSats: 50,
    })
    expect(e2e.tg.of('sendMessage').some(call => /Thanks.*50 sats/.test(String(call.text)))).toBe(
      true,
    )
    await reconcilePendingDonations()
    expectDonationLegs(1, 1)
  })
}

for (const outcome of [
  'paid',
  'failed',
  '404',
  'expired',
  'ttl',
  'live',
  'lookup-error',
] as const) {
  test(`pending one-shot background reconciliation: ${outcome}`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    e2e.ln.state.pendingNextPay = true
    await e2e.send(privateCallback(donateAmountRoute.build({amountSats: 50})))
    const [row] = await e2e.container.donations.listPending(USER_A, 'one_shot')
    if (!row) throw new Error('Expected pending one-shot')
    if (outcome === 'paid') settleDonation(row.paymentHash)
    if (outcome === 'failed') {
      const lookup = await e2e.container.masterWallet.lookupFeePayment(row.paymentHash)
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${row.paymentHash}`},
        {status: 200, body: {...lookup, status: 'failed'}},
      )
    }
    if (outcome === 'expired')
      for (const payment of e2e.ln.state.payments) payment.expiresAt = new Date(Date.now() - 1000)
    if (outcome === '404' || outcome === 'lookup-error')
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${row.paymentHash}`},
        {status: outcome === '404' ? 404 : 400, body: {detail: 'Unavailable'}},
      )
    if (outcome === 'ttl') {
      const lookup = await e2e.container.masterWallet.lookupFeePayment(row.paymentHash)
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${row.paymentHash}`},
        {
          status: 200,
          body: {...lookup, details: {...lookup.details, expiry: null}},
        },
      )
    }
    const now = outcome === 'ttl' ? new Date(row.expiresAt.getTime() + 1000) : new Date()
    await reconcilePendingDonations(now)
    await reconcilePendingDonations(now)
    const waits = outcome === 'live' || outcome === 'lookup-error'
    expect(await e2e.container.donations.listPending()).toHaveLength(waits ? 1 : 0)
    expect(await e2e.container.donations.getUserStats(USER_A)).toMatchObject({
      count: outcome === 'paid' ? 1 : 0,
      totalSats: outcome === 'paid' ? 50 : 0,
    })
    expectDonationLegs(1, 1)
  })
}

for (const outcome of ['failed', 'expired', '404'] as const) {
  test(`explicit one-shot retry may create a new invoice after ${outcome}`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    e2e.ln.state.pendingNextPay = true
    await e2e.send(privateCallback(donateAmountRoute.build({amountSats: 50})))
    const [row] = await e2e.container.donations.listPending()
    if (!row) throw new Error('Expected pending one-shot')
    if (outcome === '404')
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${row.paymentHash}`},
        {status: 404, body: {detail: 'Missing'}},
      )
    else
      for (const payment of e2e.ln.state.payments) {
        if (outcome === 'failed') payment.failed = true
        else payment.expiresAt = new Date(Date.now() - 1000)
      }
    if (outcome === 'failed') {
      const lookup = await e2e.container.masterWallet.lookupFeePayment(row.paymentHash)
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${row.paymentHash}`},
        {status: 200, body: {...lookup, status: 'failed'}},
      )
    }
    await e2e.send(privateCallback(donateAmountRoute.build({amountSats: 100})))
    expect(await e2e.container.donations.listPending()).toHaveLength(0)
    expect(await e2e.container.donations.getUserStats(USER_A)).toMatchObject({
      count: 1,
      totalSats: 100,
    })
    expectDonationLegs(2, 2)
  })
}

test('percent collections keep two independent pending hashes and reconcile them separately', async () => {
  await seedUser(e2e, {id: USER_A, donationPercent: 5})
  credit(USER_A, STARTING)
  const collect = (baseAmountSats: number) =>
    e2e.container.donationCollect.tryCollect({
      userId: USER_A,
      baseAmountSats,
      kind: 'tip',
      preferredRail: 'internal',
    })
  e2e.ln.state.pendingNextPay = true
  expect((await collect(100)).status).toBe('pending')
  e2e.ln.state.pendingNextPay = true
  expect((await collect(200)).status).toBe('pending')
  const rows = await e2e.container.donations.listPending(USER_A, 'percent')
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.amountSats).sort((a, b) => a - b)).toEqual([5, 10])
  const first = rows.find(row => row.amountSats === 5)
  const second = rows.find(row => row.amountSats === 10)
  if (!first || !second) throw new Error('Expected two different tip invoices')
  expect(first.paymentHash).not.toBe(second.paymentHash)
  settleDonation(first.paymentHash)
  // The old paid hash is reconciled at the beginning of the next collection, without skipping it.
  expect((await collect(300)).status).toBe('collected')
  expect(await e2e.container.donations.findByPaymentHash(first.paymentHash)).toMatchObject({
    amountSats: 5,
    kind: 'percent',
  })
  expect(await e2e.container.donations.listPending()).toHaveLength(1)
  await reconcilePendingDonations()
  expect(await e2e.container.donations.listPending()).toHaveLength(1)
  settleDonation(second.paymentHash)
  await Promise.all([reconcilePendingDonations(), reconcilePendingDonations()])
  expect(await e2e.container.donations.listPending()).toHaveLength(0)
  expect(await e2e.container.donations.getUserStats(USER_A)).toMatchObject({
    count: 3,
    totalSats: 30,
  })
  expectDonationLegs(3, 3)
})

for (const source of ['lookup', 'saved'] as const) {
  test(`monthly pending with expired ${source} TTL retries despite pending status`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    e2e.ln.state.pendingNextPay = true
    await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 50})))
    const user = await e2e.container.users.getOrThrow(USER_A)
    await processMonthlyDonations()
    expectDonationLegs(1, 1)
    const expired = new Date(Date.now() - 1000)
    if (source === 'lookup')
      for (const payment of e2e.ln.state.payments) payment.expiresAt = expired
    else {
      await e2e.container.users.update(USER_A, {monthlyDonationExpiresAt: expired})
      const lookup = await e2e.container.masterWallet.lookupFeePayment(
        user.monthlyDonationLastHash ?? '',
      )
      e2e.ln.state.failAlways(
        {method: 'GET', path: `/api/v1/payments/${user.monthlyDonationLastHash}`},
        {status: 200, body: {...lookup, details: {...lookup.details, expiry: null}}},
      )
    }
    await processMonthlyDonations()
    expect(await e2e.container.users.getOrThrow(USER_A)).toMatchObject({
      monthlyDonationLastHash: null,
      monthlyDonationExpiresAt: null,
    })
    expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(1)
    expectDonationLegs(2, 2)
  })
}

test('paid monthly recovery keeps a future schedule and clears hash and TTL', async () => {
  await seedUser(e2e, {id: USER_A, donationPercent: 0})
  credit(USER_A, STARTING)
  e2e.ln.state.pendingNextPay = true
  await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 50})))
  const user = await e2e.container.users.getOrThrow(USER_A)
  const hash = user.monthlyDonationLastHash
  if (!hash) throw new Error('Expected pending monthly')
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  await e2e.container.users.update(USER_A, {monthlyDonationNextAt: future})
  const saved = (await e2e.container.users.getOrThrow(USER_A)).monthlyDonationNextAt
  settleDonation(hash)
  await processMonthlyDonations()
  await processMonthlyDonations()
  expect(await e2e.container.users.getOrThrow(USER_A)).toMatchObject({
    monthlyDonationNextAt: saved,
    monthlyDonationLastHash: null,
    monthlyDonationExpiresAt: null,
  })
  expect((await e2e.container.donations.getUserStats(USER_A)).count).toBe(1)
  expectDonationLegs(1, 1)
})

test('custom monthly re-enable after disable describes the previous payment without zero sats', async () => {
  await seedUser(e2e, {id: USER_A, donationPercent: 0})
  credit(USER_A, STARTING)
  e2e.ln.state.pendingNextPay = true
  await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 50})))
  await e2e.send(privateCallback(staticCallback.donateMonthlyDisable))
  const mark = e2e.tg.calls.length
  await e2e.send(privateCallback(staticCallback.donateMonthlyCustom))
  await e2e.send(privateText('100'))
  const texts = e2e.tg.calls
    .slice(mark)
    .filter(c => c.method === 'sendMessage')
    .map(c => String(c.payload.text))
  expect(texts.some(text => /previous payment is awaiting confirmation/.test(text))).toBe(true)
  expect(texts.every(text => !/donation of 0 sats/.test(text))).toBe(true)
  expectDonationLegs(1, 1)
})

function settleDonation(hash: string): void {
  for (const payment of e2e.ln.state.payments.filter(row => row.paymentHash === hash)) {
    if (!payment.out && !payment.paid) e2e.ln.state.credit(payment.walletId, payment.amountMsat)
    payment.paid = true
  }
}

/** Every outgoing leg is the donor debit: owner payouts and duplicate refunds must be zero. */
function expectDonationLegs(invoices: number, debits: number): void {
  const feeWalletId = e2e.ln.state.wallets.find(wallet => wallet.name === FEES)?.id
  const donorWalletId = e2e.ln.state.wallets.find(wallet => wallet.name === `${USER_A} wallet`)?.id
  expect(feeWalletId).toBeDefined()
  expect(donorWalletId).toBeDefined()
  const incoming = e2e.ln.state.payments.filter(payment => !payment.out)
  const outgoing = e2e.ln.state.payments.filter(payment => payment.out)
  expect(incoming).toHaveLength(invoices)
  expect(outgoing).toHaveLength(debits)
  expect(incoming.filter(payment => payment.walletId === feeWalletId)).toHaveLength(invoices)
  expect(outgoing.filter(payment => payment.walletId === donorWalletId)).toHaveLength(debits)
  expect(outgoing.filter(payment => payment.walletId !== donorWalletId)).toHaveLength(0)
}

for (const source of ['preset', 'custom'] as const) {
  for (const committed of [false, true]) {
    test(`${source} monthly ledger error preserves recovery (already committed: ${committed})`, async () => {
      await seedUser(e2e, {id: USER_A, donationPercent: 0})
      credit(USER_A, STARTING)
      if (source === 'custom') await e2e.send(privateCallback(staticCallback.donateMonthlyCustom))
      const {donations, users} = e2e.container
      const insertDonation = donations.insertDonation
      const before = await snapshot(e2e)
      const mark = e2e.tg.calls.length
      const ledger = spyOn(donations, 'insertDonation').mockImplementationOnce(async input => {
        if (committed) await insertDonation(input)
        throw new Error('monthly ledger unavailable')
      })
      try {
        await e2e.send(
          source === 'custom'
            ? privateText('100')
            : privateCallback(donateMonthlyAmountRoute.build({amountSats: 100})),
        )
      } finally {
        ledger.mockRestore()
      }
      const pending = await users.getOrThrow(USER_A)
      const hash = pending.monthlyDonationLastHash
      expect(hash).toBeTruthy()
      expect(pending.monthlyDonationExpiresAt).toBeInstanceOf(Date)
      expect(pending.monthlyDonationSats).toBe(100)
      expect(pending.monthlyDonationNextAt?.getTime()).toBeLessThanOrEqual(Date.now())
      expect((await donations.getUserStats(USER_A)).count).toBe(committed ? 1 : 0)
      const texts = e2e.tg.calls.slice(mark).map(call => String(call.payload.text))
      expect(texts.some(text => /current payment is awaiting confirmation/.test(text))).toBe(true)
      expect(texts.some(text => /Monthly donation set to/.test(text))).toBe(false)
      expectDonationLegs(1, 1)
      await expectNoConversations(e2e.db)

      const lookup = spyOn(e2e.container.masterWallet, 'lookupFeePayment')
      try {
        await processMonthlyDonations()
        await processMonthlyDonations()
        expect(lookup).toHaveBeenCalledTimes(1)
        expect(lookup).toHaveBeenCalledWith(hash)
      } finally {
        lookup.mockRestore()
      }
      const finalized = await users.getOrThrow(USER_A)
      expect(finalized.monthlyDonationNextAt?.getTime()).toBeGreaterThan(Date.now())
      expect(finalized.monthlyDonationLastHash).toBeNull()
      expect(finalized.monthlyDonationExpiresAt).toBeNull()
      expect(await donations.findByPaymentHash(hash ?? '')).toMatchObject({
        userId: USER_A,
        amountSats: 100,
        kind: 'monthly',
      })
      expect(await donations.getUserStats(USER_A)).toMatchObject({count: 1, totalSats: 100})
      expectDonationLegs(1, 1)
      expectLedgerBalanced(before, await snapshot(e2e))
    })
  }
}

for (const source of ['preset', 'custom'] as const) {
  test(`Disable after ${source} monthly issuance keeps paid donation but shows no enabled confirmation`, async () => {
    await seedUser(e2e, {id: USER_A, donationPercent: 0})
    credit(USER_A, STARTING)
    if (source === 'custom') await e2e.send(privateCallback(staticCallback.donateMonthlyCustom))
    const {donations, users} = e2e.container
    const saveMonthlyIssued = donations.saveMonthlyIssued
    let hash: string | undefined
    // Keep real SQL and both HTTP transports; inject Disable's write at the issuance boundary.
    const issuance = spyOn(donations, 'saveMonthlyIssued').mockImplementationOnce(
      async (...args) => {
        const saved = await saveMonthlyIssued(...args)
        expect(saved).toBe(true)
        hash = args[2].paymentHash
        expect((await users.getOrThrow(USER_A)).monthlyDonationLastHash).toBe(hash)
        await users.update(USER_A, {monthlyDonationSats: 0, monthlyDonationNextAt: null})
        return saved
      },
    )
    const mark = e2e.tg.calls.length
    try {
      await e2e.send(
        source === 'custom'
          ? privateText('100')
          : privateCallback(donateMonthlyAmountRoute.build({amountSats: 100})),
      )
    } finally {
      issuance.mockRestore()
    }
    expect(hash).toBeTruthy()
    expect(await users.getOrThrow(USER_A)).toMatchObject({
      monthlyDonationSats: 0,
      monthlyDonationNextAt: null,
      monthlyDonationLastHash: null,
      monthlyDonationExpiresAt: null,
    })
    expect(await donations.findByPaymentHash(hash ?? '')).toMatchObject({
      userId: USER_A,
      amountSats: 100,
      kind: 'monthly',
    })
    expect(await donations.getUserStats(USER_A)).toMatchObject({count: 1, totalSats: 100})
    const calls = e2e.tg.calls.slice(mark)
    expect(calls.some(call => /Monthly donation set to/.test(String(call.payload.text)))).toBe(
      false,
    )
    expect(calls.some(call => call.method === 'sendRichMessage')).toBe(true)
    await processMonthlyDonations()
    expect((await donations.getUserStats(USER_A)).count).toBe(1)
    expectDonationLegs(1, 1)
    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}
