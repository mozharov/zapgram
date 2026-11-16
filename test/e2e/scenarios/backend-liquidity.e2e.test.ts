import {afterEach, beforeEach, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {SendPausedError} from '@core/errors/send-paused.js'
import {processMonthlyDonations} from '@modules/donations/jobs/process-monthly-donations.js'
import {
  donateAmountRoute,
  donateMonthlyAmountRoute,
  featureFundAmountRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {translate} from '@telegram/i18n/i18n.js'
import {encode, toWords} from 'bech32'
import {expectPayoutsExactly} from '../asserts.js'
import {mintInvoice} from '../fakes/bolt11.js'
import {CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedSubscription, seedSubscriptionPayment, seedUser} from '../fixtures/seed.js'
import {groupText, privateCallback, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['backend-liquidity']

/**
 * Only an external BOLT11 needs funding-source liquidity. Invoices this LNbits issued
 * (tips, donations, renewals, settlement) are internal ledger moves and still pay when
 * the backend balance is zero. A failed status read does not pause either.
 */

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({env: {LOG_LEVEL: 'info'}})
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
})

afterEach(async () => {
  await e2e.dispose()
})

test('zero backend balance pauses a wallet payment without calling pay', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 100, description: 'empty backend'})
  const before = await snapshot(e2e)
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(messageTexts()).toContain(translate('error.send-paused', 'en'))
  expect(outgoingPaysSince(mark)).toEqual([])
  const after = await snapshot(e2e)
  expect(after.lnbits.wallets).toEqual(before.lnbits.wallets)
  const paused = e2e.logs.filter(entry => String(entry.msg).includes('Outgoing payment paused'))
  expect(paused.length).toBeGreaterThan(0)
  expect(JSON.stringify(paused)).not.toContain(invoice.bolt11)
  expect(JSON.stringify(paused)).not.toContain(e2e.container.config.LNBITS_ADMIN_KEY)
})

test('enough backend balance pays the invoice', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 100_000_000
  const invoice = mintInvoice({sats: 100, description: 'funded backend'})
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(pathsSince(mark)).toContain('GET /api/v1/status')
})

test('a failed balance check does not pause an external payment', async () => {
  credit(USER_A, 1000)
  const invoice = mintInvoice({sats: 100, description: 'status down'})

  await e2e.send(privateText(invoice.bolt11))
  const mark = e2e.ln.requests.length
  e2e.ln.state.failNext(
    {method: 'GET', path: '/api/v1/status'},
    {status: 500, body: {detail: 'status down'}},
  )
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
  const noted = e2e.logs.filter(entry =>
    String(entry.msg).includes('Backend liquidity check failed'),
  )
  expect(noted.length).toBeGreaterThan(0)
  expect(JSON.stringify(noted)).not.toContain(invoice.bolt11)
  expect(JSON.stringify(noted)).not.toContain('status down')
})

test('the pause copy is Russian when the sender is Russian', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'ru',
  })
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 50, description: 'пусто'})

  await e2e.send(
    privateText(invoice.bolt11, {
      from: {id: USER_A, username: 'user_a', first_name: 'User A', language_code: 'ru'},
    }),
  )
  await e2e.send(
    pressWallet('internal', requiredPromptMessageId(), {
      id: USER_A,
      username: 'user_a',
      first_name: 'User A',
      language_code: 'ru',
    }),
  )

  expect(messageTexts()).toContain(translate('error.send-paused', 'ru'))
  expect(outgoingPaysSince(0)).toEqual([])
})

test('an internal tip does not wait for a hung funding-source status', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 0,
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, 1000)
  e2e.ln.state.hangFundingSourceStatus = true
  const mark = e2e.ln.requests.length
  const started = Date.now()

  await e2e.send(groupText('/tip 21 @user_b'))

  expect(Date.now() - started).toBeLessThan(4_000)
  expect(pathsSince(mark)).not.toContain('GET /api/v1/status')
  expect(
    e2e.tg.of('sendMessage').some(call => /sent 21 sats to @user_b/.test(String(call.text))),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
})

test('a group tip still pays when the backend balance is zero', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 0,
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const mark = e2e.ln.requests.length

  await e2e.send(groupText('/tip 21 @user_b'))

  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
  expect(
    e2e.tg.of('sendMessage').some(call => /sent 21 sats to @user_b/.test(String(call.text))),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(e2e.tg.of('sendMessage').some(call => Number(call.chat_id) === USER_B)).toBe(true)
})

test('a donation, a renewal, and a settlement still pay when the backend balance is zero', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: 1000})
  credit(USER_A, 10_000)
  e2e.ln.state.fundingSourceBalanceMsat = 0

  const donationMark = e2e.ln.requests.length
  const donation = await e2e.container.donationPay.payDonation({
    userId: USER_A,
    amountSats: 21,
    kind: 'one_shot',
    rail: 'internal',
  })
  expect(donation.status).toBe('paid')
  expect(outgoingPaysSince(donationMark)).toHaveLength(1)

  const subscription = await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: 100,
    autoRenew: true,
    endsAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  const renewalMark = e2e.ln.requests.length
  const renewal = await e2e.container.renewalService.attemptAutoRenewal(
    subscription,
    await e2e.container.chats.getOrThrow(CHAT_GROUP),
  )
  expect(renewal.status).not.toBe('failed')
  expectPayoutsExactly(e2e.ln, {toWallet: `${OWNER} wallet`, sats: 95, times: 1})
  const fees = e2e.ln.state.wallets.find(wallet => wallet.name === 'fees wallet')
  if (!fees) throw new Error('fees wallet missing')
  const feeLegs = e2e.ln.state.payments.filter(
    payment =>
      !payment.out && payment.paid && payment.walletId === fees.id && payment.amountMsat === 5_000,
  )
  expect(feeLegs).toHaveLength(1)
  expectPayoutsExactly(e2e.ln, {toWallet: `${USER_A} wallet`, sats: 100, times: 0})
  expect(pathsSince(renewalMark).some(path => path.includes('/payments/all/paginated'))).toBe(false)

  const settled = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: true,
    price: 1000,
    kind: 'renewal',
  })
  e2e.ln.state.fundingSourceBalanceMsat = 0
  // Empty admin list would classify the payout as external and pause it. knownInternal must not ask.
  e2e.ln.state.adminPaymentListEmpty = true
  e2e.ln.state.failAlways(
    {method: 'GET', path: '/api/v1/wallet'},
    {status: 500, body: {status: 'failed', detail: 'wallet id unread'}},
  )
  const settleMark = e2e.ln.requests.length
  expect(await e2e.container.settleService.complete(settled)).toBe('settled')
  expect(outgoingPaysSince(settleMark)).toHaveLength(2)
  expect(pathsSince(settleMark).some(path => path.includes('/payments/all/paginated'))).toBe(false)
  expect(pathsSince(settleMark).some(path => path === 'GET /api/v1/wallet')).toBe(false)
  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
})

test('the master wallet pay is paused without calling pay when the backend is empty', async () => {
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const invoice = mintInvoice({sats: 10, description: 'owner payout'})
  const mark = e2e.ln.requests.length

  await expect(e2e.container.masterWallet.payInvoice(invoice.bolt11)).rejects.toBeInstanceOf(
    SendPausedError,
  )
  expect(outgoingPaysSince(mark)).toEqual([])
})

test('a funding-source error does not pause an external payment', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.fundingSourceError = 'nwc down'
  const invoice = mintInvoice({sats: 40, description: 'error ignored'})
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(JSON.stringify(e2e.logs)).not.toContain('nwc down')
})

test('a non-admin status body does not pause payments even when the stored balance is zero', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.fundingSourceVisible = false
  const invoice = mintInvoice({sats: 100, description: 'balance hidden'})
  const mark = e2e.ln.requests.length

  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
})

test('enabling a monthly donation while sends are paused keeps the subscription on', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true
  const mark = e2e.ln.requests.length

  await e2e.send(privateCallback(donateMonthlyAmountRoute.build({amountSats: 21})))

  expect(
    messageTexts().some(text => /Monthly donation of 21 sats/.test(text) && /paused/.test(text)),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toEqual([])
  const user = await e2e.container.users.findById(USER_A)
  expect(user?.monthlyDonationSats).toBe(21)
  expect(user?.monthlyDonationNextAt).toBeInstanceOf(Date)
})

test('an optional tip donation pauses after the tip itself is paid', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 5,
    donationScope: 'tips',
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true
  const mark = e2e.ln.requests.length

  await e2e.send(groupText('/tip 100 @user_b'))

  expect(
    e2e.tg.of('sendMessage').some(call => /sent 100 sats to @user_b/.test(String(call.text))),
  ).toBe(true)
  expect(
    messageTexts().some(text => /support tip was not sent/.test(text) && /5 sat/.test(text)),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(0)
  expect(pathsSince(mark).filter(path => path.includes('/payments/all/paginated'))).toHaveLength(1)
})

test('a one-shot donation pauses before pay when the invoice is external and the backend is empty', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true
  const before = await snapshot(e2e)
  const mark = e2e.ln.requests.length

  await e2e.send(privateCallback(donateAmountRoute.build({amountSats: 21})))

  expect(
    messageTexts().some(text => /Could not send 21 sats/.test(text) && /paused/.test(text)),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toEqual([])
  expect((await snapshot(e2e)).lnbits.wallets).toEqual(before.lnbits.wallets)
  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(0)
})

test('the monthly donation cron pauses the charge and leaves the schedule due', async () => {
  const dueAt = new Date(Date.now() - 60_000)
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    monthlyDonationSats: 21,
    monthlyDonationNextAt: dueAt,
  })
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true
  const mark = e2e.ln.requests.length

  await processMonthlyDonations()

  expect(
    messageTexts().some(
      text => /21 sat/.test(text) && /was not charged/.test(text) && /stays on/.test(text),
    ),
  ).toBe(true)
  expect(outgoingPaysSince(mark)).toEqual([])
  const user = await e2e.container.users.findById(USER_A)
  expect(user?.monthlyDonationSats).toBe(21)
  expect(user?.monthlyDonationLastHash ?? null).toBeNull()
  const storedDue = user?.monthlyDonationNextAt?.getTime() ?? 0
  expect(Math.abs(storedDue - dueAt.getTime())).toBeLessThan(2_000)
  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(0)
})

test('feature-request funding pauses and still submits the request', async () => {
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true
  const mark = e2e.ln.requests.length

  await e2e.send(privateCallback(staticCallback.featureRequest))
  await e2e.send(privateText('Show a pause instead of sending'))
  await e2e.send(
    privateCallback(featureFundAmountRoute.build({amountSats: 21}), {
      messageId: requiredPromptMessageId(),
    }),
  )

  const report = e2e.tg.of('editMessageText').map(call => String(call.text))
  expect(report.some(text => text.includes(translate('error.send-paused', 'en')))).toBe(true)
  expect(outgoingPaysSince(mark)).toEqual([])
  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(0)
})

test('settlement pays the owner and the fee once, and a duplicate refunds once', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active', price: 1000})
  e2e.ln.state.fundingSourceBalanceMsat = 0
  const intent = await e2e.container.subscriptionIntents.create({
    userId: USER_A,
    chatId: CHAT_GROUP,
    kind: 'renewal',
  })
  const winner = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: true,
    price: 1000,
    kind: 'renewal',
    intentId: intent.id,
  })
  const duplicate = await seedSubscriptionPayment(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    paid: true,
    price: 1000,
    kind: 'renewal',
    intentId: intent.id,
    isCurrent: false,
  })
  expect(await e2e.container.settleService.complete(winner)).toBe('settled')
  expect(await e2e.container.settleService.complete(duplicate)).toBe('settled')

  expectPayoutsExactly(e2e.ln, {toWallet: `${OWNER} wallet`, sats: 950, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees wallet', sats: 50, times: 1})
  expectPayoutsExactly(e2e.ln, {toWallet: `${USER_A} wallet`, sats: 1000, times: 1})
  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
})

test('startup names a zero balance with an empty error and still pauses external sends', async () => {
  await e2e.dispose()
  e2e = await createE2E({
    env: {LOG_LEVEL: 'info'},
    prepareLn(ln) {
      ln.state.fundingSourceBalanceMsat = 0
    },
  })
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  const startup = e2e.logs.filter(entry =>
    String(entry.msg).includes('Funding source balance is 0 with an empty error'),
  )
  expect(startup).toHaveLength(1)
  expect(startup[0]).toMatchObject({
    reason: 'zero_balance',
    liquidityMode: 'active',
    classify: 'ok',
  })

  credit(USER_A, 1000)
  const invoice = mintInvoice({sats: 10, description: 'still paused'})
  const mark = e2e.ln.requests.length
  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))
  expect(messageTexts()).toContain(translate('error.send-paused', 'en'))
  expect(outgoingPaysSince(mark)).toEqual([])
})

test('an unrecognized guard value warns once and leaves the check on', async () => {
  await e2e.dispose()
  e2e = await createE2E({
    env: {LOG_LEVEL: 'info', BACKEND_LIQUIDITY_GUARD: 'maybe'},
  })
  const warned = e2e.logs.filter(entry =>
    String(entry.msg).includes('BACKEND_LIQUIDITY_GUARD is not recognized'),
  )
  expect(warned).toHaveLength(1)
  expect(warned[0]).toMatchObject({unrecognized: true, length: 'maybe'.length})
  expect(JSON.stringify(warned[0])).not.toContain('maybe')
  expect(e2e.container.config.BACKEND_LIQUIDITY_GUARD).toBe('on')
})

test('a missing bearer is logged once and an internal tip does not warn again', async () => {
  await e2e.dispose()
  e2e = await createE2E({
    env: {LOG_LEVEL: 'info', LNBITS_BEARER_TOKEN: ''},
  })
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  const startup = e2e.logs.find(entry => String(entry.msg) === 'Funding source liquidity check')
  expect(startup).toMatchObject({
    liquidityMode: 'disabled',
    reason: 'missing_bearer',
    classify: 'missing_bearer',
  })
  credit(USER_A, 1000)
  await e2e.send(groupText('/tip 21 @user_b'))
  expect(
    e2e.tg.of('sendMessage').some(call => /sent 21 sats to @user_b/.test(String(call.text))),
  ).toBe(true)
  expect(e2e.logs.some(entry => String(entry.msg).includes('Backend liquidity check failed'))).toBe(
    false,
  )
})

test('BACKEND_LIQUIDITY_GUARD=off disables the check and lets an external send through', async () => {
  await e2e.dispose()
  e2e = await createE2E({
    env: {LOG_LEVEL: 'info', BACKEND_LIQUIDITY_GUARD: 'off'},
    prepareLn(ln) {
      ln.state.fundingSourceBalanceMsat = 0
    },
  })
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  const startup = e2e.logs.find(entry => String(entry.msg) === 'Funding source liquidity check')
  expect(startup).toMatchObject({
    liquidityMode: 'disabled',
    reason: 'guard_off',
    classify: 'skipped',
  })

  credit(USER_A, 1000)
  const invoice = mintInvoice({sats: 10, description: 'guard off'})
  const mark = e2e.ln.requests.length
  await e2e.send(privateText(invoice.bolt11))
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Invoice paid/)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
  expect(messageTexts().some(text => text.includes('temporarily paused'))).toBe(false)
})

test('the master wallet pays when the backend covers the invoice and the reserve', async () => {
  const master = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!master) throw new Error('Fake master wallet not found')
  e2e.ln.state.credit(master.id, 100_000_000)
  e2e.ln.state.fundingSourceBalanceMsat = 100_000_000
  const invoice = mintInvoice({sats: 10, description: 'owner payout ok'})
  const mark = e2e.ln.requests.length

  const payment = await e2e.container.masterWallet.payInvoice(invoice.bolt11)

  expect(payment.amount).toBe(-10_000)
  expect(outgoingPaysSince(mark)).toHaveLength(1)
})

test('Send pauses an external BOLT11 and an LNURL pay, and still pays an internal username', async () => {
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    donationPercent: 0,
  })
  await seedUser(e2e, {id: USER_B, username: 'user_b', firstName: 'User B'})
  e2e.tg.reply('getChat', {
    id: USER_B,
    type: 'private',
    username: 'user_b',
    first_name: 'User B',
  })
  credit(USER_A, 1000)
  e2e.ln.state.fundingSourceBalanceMsat = 0
  e2e.ln.state.adminPaymentListEmpty = true

  const bolt11 = mintInvoice({sats: 40, description: 'send button'})
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText(bolt11.bolt11))
  const bolt11Mark = e2e.ln.requests.length
  await e2e.send(pressWallet('internal', requiredPromptMessageId()))

  expect(screenText()).toContain(translate('error.send-paused', 'en'))
  expect(outgoingPaysSince(bolt11Mark)).toEqual([])

  const server = startLnurlServer()
  try {
    await e2e.send(privateCallback(staticCallback.sendMenu))
    await e2e.send(privateText(server.lnurl))
    await e2e.send(privateText('30'))
    const lnurlMark = e2e.ln.requests.length
    await e2e.send(pressWallet('internal', requiredPromptMessageId()))

    expect(screenText()).toContain(translate('error.send-paused', 'en'))
    expect(outgoingPaysSince(lnurlMark)).toEqual([])
  } finally {
    server.stop()
  }

  e2e.ln.state.hangFundingSourceStatus = true
  const usernameMark = e2e.ln.requests.length
  const shownBefore = screenText().length
  const started = Date.now()
  await e2e.send(privateCallback(staticCallback.sendMenu))
  await e2e.send(privateText('@user_b'))
  await e2e.send(privateText('21'))
  await e2e.send(confirmSend(requiredPromptMessageId()))

  expect(Date.now() - started).toBeLessThan(4_000)
  expect(pathsSince(usernameMark)).not.toContain('GET /api/v1/status')
  expect(outgoingPaysSince(usernameMark)).toHaveLength(1)
  const fresh = screenText().slice(shownBefore)
  expect(fresh.some(text => /@user_b/.test(text) && /21/.test(text))).toBe(true)
  expect(fresh.some(text => text.includes('temporarily paused'))).toBe(false)
})

function startLnurlServer(): {lnurl: string; stop: () => void} {
  const metadata = JSON.stringify([
    ['text/plain', 'Pay Alice'],
    ['text/identifier', 'alice@example.com'],
  ])
  let port = 0
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') {
        return Response.json({
          tag: 'payRequest',
          callback: `http://127.0.0.1:${port}/callback`,
          minSendable: 10_000,
          maxSendable: 100_000,
          metadata,
        })
      }
      const hash = createHash('sha256').update(metadata).digest('hex')
      const invoice = mintInvoice({sats: 30, descriptionHash: hash})
      return Response.json({pr: invoice.bolt11})
    },
  })
  if (http.port === undefined) throw new Error('LNURL test server has no port')
  port = http.port
  return {
    lnurl: encode('lnurl', toWords(Buffer.from(`http://127.0.0.1:${port}/pay`)), 5000),
    stop() {
      http.stop(true)
    },
  }
}

function callbackData(prefix: string): string {
  const payloads = [...e2e.tg.of('editMessageText'), ...e2e.tg.of('sendMessage')].reverse()
  for (const payload of payloads) {
    const markup = payload.reply_markup as
      | {inline_keyboard?: {callback_data?: string}[][]}
      | undefined
    const data = (markup?.inline_keyboard ?? [])
      .flat()
      .map(button => button.callback_data)
      .find(value => value?.startsWith(prefix))
    if (data) return data
  }
  throw new Error(`Expected a ${prefix} button`)
}

function pressWallet(
  which: 'internal' | 'nwc',
  messageId: number,
  from?: {id: number; username?: string; first_name?: string; language_code?: string},
) {
  return privateCallback(callbackData(`${which}:`), {messageId, ...(from ? {from} : {})})
}

function confirmSend(messageId: number) {
  return privateCallback(callbackData('confirm-send:'), {messageId})
}

function screenText(): string[] {
  return [...e2e.tg.of('sendMessage'), ...e2e.tg.of('editMessageText')].map(call =>
    String(call.text),
  )
}

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function requiredPromptMessageId(): number {
  const edited = e2e.tg.lastMessageId('editMessageText')
  if (edited !== undefined) return edited
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound text prompt message ID')
  return messageId
}

function outgoingPaysSince(mark: number) {
  return e2e.ln.requests.slice(mark).filter(request => {
    if (request.method !== 'POST' || request.path !== '/api/v1/payments') return false
    const body = request.body
    return Boolean(body && typeof body === 'object' && Reflect.get(body, 'out') === true)
  })
}

function pathsSince(mark: number): string[] {
  return e2e.ln.requests.slice(mark).map(request => `${request.method} ${request.path}`)
}

function messageTexts(): string[] {
  return e2e.tg.of('sendMessage').map(call => String(call.text))
}
