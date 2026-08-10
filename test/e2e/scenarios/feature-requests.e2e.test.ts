import {afterEach, beforeEach, expect, test} from 'bun:test'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {OWNER, USER_A} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['feature-requests']

const STARTING = 50_000
const FEES = 'fees wallet'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({
    env: {ADMIN_TELEGRAM_IDS: String(OWNER)},
  })
})

afterEach(async () => {
  await e2e.dispose()
})

test('/feature with text and skip: meta + copyMessage to admin', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature Built-in on-chain wallet'))

  const fundPrompt = e2e.tg
    .of('sendMessage')
    .some(c => /attach sats|прикрепить/i.test(String(c.text)))
  expect(fundPrompt).toBe(true)

  await e2e.send(privateCallback(staticCallback.featureFundSkip))

  const adminMeta = e2e.tg
    .of('sendMessage')
    .filter(c => Number(c.chat_id) === OWNER)
    .map(c => String(c.text))
  expect(adminMeta.some(t => t.includes('@user_a') && /Fund: none/i.test(t))).toBe(true)
  // Body lives in the copy, not the meta message.
  expect(adminMeta.every(t => !t.includes('Built-in on-chain wallet'))).toBe(true)

  const copies = e2e.tg.of('copyMessage').filter(c => Number(c.chat_id) === OWNER)
  expect(copies.length).toBeGreaterThanOrEqual(1)
  expect(Number(copies[0]?.from_chat_id)).toBe(USER_A)

  const userMsgs = e2e.tg
    .of('sendMessage')
    .filter(c => Number(c.chat_id) === USER_A)
    .map(c => String(c.text))
  expect(userMsgs.some(t => /Thanks! Your feature request was sent/i.test(t))).toBe(true)
  expectNoErrors(e2e.logs)
})

test('/feature fund 1000: donation + meta + copyMessage', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  credit(USER_A, STARTING)

  const before = await snapshot(e2e)
  await e2e.send(privateCommand('/feature NWC multi-wallet'))

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(featureFundAmountRoute.build({amountSats: 1000}))),
    {
      db: {
        donations: {added: 1},
        donationPlatformStats: {changed: 1},
        conversations: {removed: 1},
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
        {method: 'editMessageReplyMarkup'},
        {method: 'sendChatAction', to: USER_A},
        {method: 'sendMessage', to: OWNER, text: /Funded:.*1000|1,?000/},
        {method: 'copyMessage', to: OWNER},
        {method: 'sendMessage', to: USER_A, text: /1,?000.*sats/},
      ],
    },
  )
  expectLedgerBalanced(before, await snapshot(e2e))

  const stats = await e2e.container.donations.getUserStats(USER_A)
  expect(stats.totalSats).toBe(1000)
  expectNoErrors(e2e.logs)
})

test('/feature without args: free-text message is copyMessage source', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature'))
  expect(
    e2e.tg.of('sendMessage').some(c => /What should we build|Что сделать/i.test(String(c.text))),
  ).toBe(true)

  await e2e.send(privateText('Add scheduled tips'))
  expect(e2e.tg.of('sendMessage').some(c => /attach sats|прикрепить/i.test(String(c.text)))).toBe(
    true,
  )

  await e2e.send(privateCallback(staticCallback.featureFundSkip))

  const adminMeta = e2e.tg
    .of('sendMessage')
    .filter(c => Number(c.chat_id) === OWNER)
    .map(c => String(c.text))
  expect(adminMeta.some(t => /New feature request/i.test(t) && t.includes('@user_a'))).toBe(true)
  expect(adminMeta.every(t => !t.includes('Add scheduled tips'))).toBe(true)

  const copies = e2e.tg.of('copyMessage').filter(c => Number(c.chat_id) === OWNER)
  expect(copies.length).toBeGreaterThanOrEqual(1)
  expect(Number(copies[0]?.from_chat_id)).toBe(USER_A)
  expectNoErrors(e2e.logs)
})

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}
