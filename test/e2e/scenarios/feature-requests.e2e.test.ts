import {afterEach, beforeEach, expect, test} from 'bun:test'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import {expectNoConversations, expectNoErrors} from '../asserts.js'
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

test('canceling a feature request returns to Wallet', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})

  await e2e.send(privateCommand('/feature'))
  await e2e.send(privateCallback(staticCallback.cancel, {messageId: requiredPromptMessageId()}))

  await expectNoConversations(e2e.db)
  expect(richHtmlOf(e2e.tg.last('sendRichMessage'))).toMatch(/Wallet|Кошелёк/)
  expectNoErrors(e2e.logs)
})

test('/feature with text and skip: meta + copyMessage to admin', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', donationPercent: 0})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature Built-in on-chain wallet'))

  const fundPrompt = e2e.tg
    .of('sendMessage')
    .some(c => /attach sats|прикрепить/i.test(String(c.text)))
  expect(fundPrompt).toBe(true)

  await e2e.send(
    privateCallback(staticCallback.featureFundSkip, {messageId: requiredPromptMessageId()}),
  )

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

  // The fund chooser is edited into the report rather than a new message being sent, and the report
  // carries the open-menu row so it behaves like every other receipt.
  const report = e2e.tg
    .of('editMessageText')
    .filter(c => Number(c.chat_id) === USER_A)
    .at(-1)
  expect(String(report?.text)).toMatch(/Thanks! Your feature request was sent/i)
  expect(report?.reply_markup).toEqual({
    inline_keyboard: [[{text: '👛 Open wallet', callback_data: staticCallback.openMenu}]],
  })
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
    () =>
      e2e.send(
        privateCallback(featureFundAmountRoute.build({amountSats: 1000}), {
          messageId: requiredPromptMessageId(),
        }),
      ),
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
      // The report is the fund chooser edited in place, not a separate message.
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'editMessageReplyMarkup'},
        {method: 'sendChatAction', to: USER_A},
        {method: 'sendMessage', to: OWNER, text: /Funded:.*1000|1,?000/},
        {method: 'copyMessage', to: OWNER},
        {method: 'editMessageText', to: USER_A, text: /1,?000.*sats/},
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

  await e2e.send(
    privateCallback(staticCallback.featureFundSkip, {messageId: requiredPromptMessageId()}),
  )

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

test('blank feature text retries without submission and accepts the next message', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature'))
  const textPromptMessageId = requiredPromptMessageId()
  await e2e.send(privateText('   '))

  expect((await snapshot(e2e)).db.conversations).toHaveLength(1)
  expect(e2e.tg.of('copyMessage')).toHaveLength(0)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/non-empty text|непустое текстовое/i)

  await e2e.send(privateText('Retry feature text'))

  expect(
    e2e.tg
      .of('editMessageReplyMarkup')
      .some(call => Number(call.message_id) === textPromptMessageId),
  ).toBe(true)
  await e2e.send(
    privateCallback(staticCallback.featureFundSkip, {messageId: requiredPromptMessageId()}),
  )
  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('copyMessage').some(call => Number(call.chat_id) === OWNER)).toBe(true)
  expectNoErrors(e2e.logs)
})

test('fund choice ignores ordinary text, keeps prompt active, then accepts its own button', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature Keep fund step active'))
  const promptMessageId = requiredPromptMessageId()
  await e2e.send(privateText('this is not a button'))

  expect((await snapshot(e2e)).db.conversations).toHaveLength(1)
  // Typed text is now a candidate amount, so the hint is about the number, not about the buttons.
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/whole number of sats|целое число сат/i)

  await e2e.send(privateCallback(staticCallback.featureFundSkip, {messageId: promptMessageId}))

  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('copyMessage').some(call => Number(call.chat_id) === OWNER)).toBe(true)
  expectNoErrors(e2e.logs)
})

test('a typed amount at the fund step is accepted without any extra prompt', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  credit(USER_A, STARTING)

  await e2e.send(privateCommand('/feature Custom funding'))
  const chooserId = requiredPromptMessageId()

  // The board offers presets and Skip only — any other amount is typed straight into the chat.
  expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
    staticCallback.featureFundSkip,
    featureFundAmountRoute.build({amountSats: 21}),
    featureFundAmountRoute.build({amountSats: 100}),
    featureFundAmountRoute.build({amountSats: 1000}),
    featureFundAmountRoute.build({amountSats: 10_000}),
    featureFundAmountRoute.build({amountSats: 100_000}),
    staticCallback.cancel,
  ])

  const beforeInvalid = await snapshot(e2e)
  const invalidAmountUpdate = privateText('0 sats')
  const invalidMark = e2e.tg.calls.length
  await e2e.send(invalidAmountUpdate)

  const afterInvalid = await snapshot(e2e)
  expect(afterInvalid.db.donations).toEqual(beforeInvalid.db.donations)
  expect(afterInvalid.lnbits).toEqual(beforeInvalid.lnbits)
  expect(afterInvalid.db.conversations).toHaveLength(1)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/whole number of sats/i)
  expect(deletedIdsSince(invalidMark)).not.toContain(invalidAmountUpdate.message?.message_id)

  const mark = e2e.tg.calls.length
  const amountUpdate = privateText('25')
  await e2e.send(amountUpdate)

  expect((await e2e.container.donations.getUserStats(USER_A)).totalSats).toBe(25)
  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('copyMessage').some(call => Number(call.chat_id) === OWNER)).toBe(true)

  // The chooser itself becomes the report — no separate amount prompt was ever sent — and the typed
  // number is cleaned up because the report echoes it.
  const report = e2e.tg.calls
    .slice(mark)
    .filter(call => call.method === 'editMessageText')
    .at(-1)
  expect(Number(report?.payload.message_id)).toBe(chooserId)
  expect(String(report?.payload.text)).toMatch(/25.*sats/)
  expect(deletedIdsSince(mark)).toContain(amountUpdate.message?.message_id)
  expectNoErrors(e2e.logs)
})

test('canceling at the fund step drops the idea message and shows the wallet', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})

  const featureUpdate = privateCommand('/feature Cancelled idea')
  await e2e.send(featureUpdate)
  const chooserId = requiredPromptMessageId()
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(staticCallback.cancel, {messageId: chooserId}))

  // Nothing was submitted, so the copyMessage source has no reader — it goes with the prompt.
  const deleted = deletedIdsSince(mark)
  expect(deleted).toContain(featureUpdate.message?.message_id)
  expect(deleted).toContain(chooserId)
  expect(richHtmlOf(e2e.tg.last('sendRichMessage'))).toMatch(/Wallet|Кошелёк/)
  await expectNoConversations(e2e.db)
  expect(e2e.tg.of('copyMessage')).toHaveLength(0)
  expectNoErrors(e2e.logs)
})

test('the feature report is a receipt: /wallet leaves it, its button opens a fresh menu', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  const featureUpdate = privateCommand('/feature Receipt behaviour')
  await e2e.send(featureUpdate)
  const chooserId = requiredPromptMessageId()
  await e2e.send(privateCallback(staticCallback.featureFundSkip, {messageId: chooserId}))

  // The report took the chooser's place, and it is no longer the living menu.
  expect(Number(e2e.tg.of('editMessageText').at(-1)?.message_id)).toBe(chooserId)
  expect((await e2e.container.users.findById(USER_A))?.lastMenuMessageId).toBeNull()
  expect((await e2e.container.users.findById(USER_A))?.lastNotificationMessageId).toBe(chooserId)

  // Its open-menu button behaves like on any receipt: row stripped, a fresh menu sent, report kept.
  const afterReport = e2e.tg.calls.length
  await e2e.send(privateCallback(staticCallback.openMenu, {messageId: chooserId}))

  expect(
    e2e.tg.calls
      .slice(afterReport)
      .filter(call => call.method === 'editMessageReplyMarkup')
      .map(call => call.payload.message_id),
  ).toContain(chooserId)
  expect(deletedIdsSince(afterReport)).not.toContain(chooserId)
  const freshMenu = e2e.tg.lastMessageId('sendRichMessage')
  expect((await e2e.container.users.findById(USER_A))?.lastMenuMessageId).toBe(freshMenu)
  expectNoErrors(e2e.logs)
})

test('a later /wallet keeps the feature report and only takes its open-menu row', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})

  await e2e.send(privateCommand('/feature Survives the next wallet'))
  const chooserId = requiredPromptMessageId()
  await e2e.send(privateCallback(staticCallback.featureFundSkip, {messageId: chooserId}))

  const afterReport = e2e.tg.calls.length
  await e2e.send(privateCommand('/wallet'))

  // The report text stays; only the button moves to the new menu, per the one-button invariant.
  expect(deletedIdsSince(afterReport)).not.toContain(chooserId)
  expect(
    e2e.tg.calls
      .slice(afterReport)
      .filter(call => call.method === 'editMessageReplyMarkup')
      .map(call => call.payload.message_id),
  ).toContain(chooserId)
  expectNoErrors(e2e.logs)
})

test('wallet callback from another message interrupts feature flow and still opens wallet', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})

  await e2e.send(privateCommand('/feature Interrupted request'))
  const promptMessageId = requiredPromptMessageId()
  await e2e.send(
    privateCallback(staticCallback.wallet, {
      messageId: promptMessageId + 1000,
    }),
  )

  await expectNoConversations(e2e.db)
  const edits = e2e.tg.of('editMessageText')
  expect(edits.some(call => Number(call.message_id) === promptMessageId)).toBe(true)
  expect(richHtmlOf(edits.at(-1))).toMatch(/Wallet|Кошелёк/i)
  expectNoErrors(e2e.logs)
})

/**
 * Every `conversation.wait()` replays the builder from the top. `showLivingMenu` reaches the DB and
 * `bot.api` directly, so unlike `ctx.api` calls those side effects are NOT replayed from the log —
 * they re-execute for real and delete the very prompt they are standing on.
 */
test('invalid fund amount keeps the input and prompt briefly, then removes both with the hint', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})

  await e2e.send(privateCommand('/feature Built-in on-chain wallet'))
  const fundPromptId = requiredPromptMessageId()
  const mark = e2e.tg.calls.length
  const invalidAmountUpdate = privateText('not a number')

  await e2e.send(invalidAmountUpdate)

  const deleted = deletedIdsSince(mark)
  expect(deleted).not.toContain(invalidAmountUpdate.message?.message_id)
  expect(deleted).not.toContain(fundPromptId)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/whole number of sats/i)
  const hintMessageId = e2e.tg.lastMessageId('sendMessage')
  if (hintMessageId === undefined) throw new Error('Expected temporary invalid amount hint')
  const inputMessageId = invalidAmountUpdate.message?.message_id
  if (inputMessageId === undefined) throw new Error('Expected invalid amount input')
  await expectTempMessagesDeleted(mark, [inputMessageId, hintMessageId])
  expectNoErrors(e2e.logs)
})

function credit(userId: number, sats: number): void {
  const lnUser = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(lnUser.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as {inline_keyboard?: {callback_data?: string}[][]}
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}

function deletedIdsSince(mark: number): unknown[] {
  return e2e.tg.calls
    .slice(mark)
    .filter(call => call.method === 'deleteMessage')
    .map(call => call.payload.message_id)
}

async function expectTempMessagesDeleted(mark: number, messageIds: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const deleted = e2e.tg.calls
      .slice(mark)
      .filter(call => call.method === 'deleteMessages')
      .flatMap(call => (Array.isArray(call.payload.message_ids) ? call.payload.message_ids : []))
    if (messageIds.every(messageId => deleted.includes(messageId))) return
    await Bun.sleep(5)
  }
  throw new Error('The temporary invalid amount input and hint were never deleted')
}

function requiredPromptMessageId(): number {
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound prompt message ID')
  return messageId
}

function richHtmlOf(payload: Record<string, unknown> | undefined): string {
  const richMessage = payload?.rich_message
  if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
  return String(Reflect.get(richMessage, 'html') ?? '')
}
