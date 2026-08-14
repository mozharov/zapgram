import {afterEach, beforeEach, expect, test} from 'bun:test'
import {chatRoute, staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {mintInvoice} from '../fakes/bolt11.js'
import {CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedChat, seedUser} from '../fixtures/seed.js'
import {privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['living-menu']

/**
 * The single-active-menu invariant: exactly one message in the private chat is a live menu, and
 * exactly one message carries the "Open wallet" button.
 *
 * These assertions read `e2e.tg.calls` directly instead of going through `expectDelta`, because
 * `chromeCalls` in `test/e2e/state.ts` filters out unlisted `deleteMessage` / `editMessageReplyMarkup`
 * calls — exactly the methods under test here. The pointer columns are read straight off the user
 * row for the same reason: `normalizeDbValue` drops them from state snapshots. This scenario is the
 * only place the bookkeeping is actually asserted, so keep it exact rather than tolerant.
 */

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A', languageCode: 'en'})
})

afterEach(async () => {
  await e2e.dispose()
})

// --- A new menu replaces the old one ---

test('a second /wallet deletes the user command and the previous menu', async () => {
  await e2e.send(privateCommand('/wallet'))
  const first = e2e.tg.lastMessageId('sendRichMessage')
  expect(await menuPointer()).toBe(first)
  const mark = e2e.tg.calls.length

  await e2e.send(privateCommand('/wallet'))

  const deleted = deletedIdsSince(mark)
  // One delete for the typed command, one for the menu that /wallet just replaced.
  expect(deleted).toContain(first)
  expect(deleted).toHaveLength(2)
  expect(methodsSince(mark).filter(method => method === 'sendRichMessage')).toHaveLength(1)
  const second = e2e.tg.lastMessageId('sendRichMessage')
  expect(second).not.toBe(first)
  expect(await menuPointer()).toBe(second)
  expectNoErrors(e2e.logs)
})

test('plain text replaces the menu the same way a command does', async () => {
  await e2e.send(privateCommand('/wallet'))
  const first = e2e.tg.lastMessageId('sendRichMessage')
  const mark = e2e.tg.calls.length

  await e2e.send(privateText('hello'))

  expect(deletedIdsSince(mark)).toContain(first)
  expect(await menuPointer()).toBe(e2e.tg.lastMessageId('sendRichMessage'))
  expectNoErrors(e2e.logs)
})

// --- Navigation inside the menu never moves it ---

test('settings and back edit the menu in place without deleting or resending', async () => {
  await e2e.send(privateCommand('/wallet'))
  const menuId = e2e.tg.lastMessageId('sendRichMessage')
  if (menuId === undefined) throw new Error('no menu was sent')
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(staticCallback.settings, {messageId: menuId}))
  await e2e.send(privateCallback(staticCallback.wallet, {messageId: menuId}))

  const methods = methodsSince(mark)
  expect(methods.filter(method => method === 'editMessageText')).toHaveLength(2)
  expect(methods).not.toContain('deleteMessage')
  expect(methods).not.toContain('sendRichMessage')
  expect(methods).not.toContain('sendMessage')
  expect(await menuPointer()).toBe(menuId)
  expectNoErrors(e2e.logs)
})

// --- Orphaned menus are adopted, never duplicated ---

test('a click on an orphaned menu adopts it and deletes the tracked one', async () => {
  await e2e.send(privateCommand('/wallet'))
  const orphan = e2e.tg.lastMessageId('sendRichMessage')
  if (orphan === undefined) throw new Error('no menu was sent')
  // Simulate the pointer having drifted onto a different message (an error path left one behind).
  await e2e.container.users.update(USER_A, {lastMenuMessageId: 4242})
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(staticCallback.settings, {messageId: orphan}))

  const methods = methodsSince(mark)
  expect(methods).toContain('editMessageText')
  // The clicked message became the menu, so the drifted pointer's message is the one that goes.
  expect(deletedIdsSince(mark)).toEqual([4242])
  expect(methods).not.toContain('sendMessage')
  expect(await menuPointer()).toBe(orphan)
  expectNoErrors(e2e.logs)
})

test('adoption survives Telegram refusing to delete the tracked menu', async () => {
  await e2e.send(privateCommand('/wallet'))
  const orphan = e2e.tg.lastMessageId('sendRichMessage')
  if (orphan === undefined) throw new Error('no menu was sent')
  await e2e.container.users.update(USER_A, {lastMenuMessageId: 4242})
  e2e.tg.fail('deleteMessage', {
    error_code: 400,
    description: 'Bad Request: message to delete not found',
  })

  await e2e.send(privateCallback(staticCallback.settings, {messageId: orphan}))

  // No second menu is spawned to "recover" — that loop is what produced multiple live menus.
  expect(await menuPointer()).toBe(orphan)
  expectNoErrors(e2e.logs)
})

// --- The open-menu button lives on exactly one message ---

test('a second notification strips the open-menu row and keeps the base keyboard', async () => {
  const payRow = [{text: 'Pay', callback_data: 'pay'}]
  await e2e.container.notifier.send(USER_A, 'first receipt', {
    reply_markup: {inline_keyboard: [payRow]},
  })
  const first = e2e.tg.lastMessageId('sendMessage')
  expect(keyboardOfLastSend()).toEqual([
    payRow,
    [{text: '👛 Open wallet', callback_data: staticCallback.openMenu}],
  ])

  await e2e.container.notifier.send(USER_A, 'second receipt')

  const stripped = e2e.tg.last('editMessageReplyMarkup')
  expect(stripped?.message_id).toBe(first)
  expect(stripped?.reply_markup).toEqual({inline_keyboard: [payRow]})
  expect(keyboardOfLastSend()).toEqual([
    [{text: '👛 Open wallet', callback_data: staticCallback.openMenu}],
  ])
  expect(await notificationPointer()).toBe(e2e.tg.lastMessageId('sendMessage'))
})

test('open-menu on a receipt strips its button and replaces the living menu', async () => {
  await e2e.send(privateCommand('/wallet'))
  const menuId = e2e.tg.lastMessageId('sendRichMessage')
  await e2e.container.notifier.send(USER_A, 'you received sats')
  const receipt = e2e.tg.lastMessageId('sendMessage')
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(staticCallback.openMenu, {messageId: receipt}))

  // Old menu gone, receipt text kept but disarmed, a fresh menu at the bottom.
  expect(deletedIdsSince(mark)).toEqual([menuId])
  expect(e2e.tg.last('editMessageReplyMarkup')?.message_id).toBe(receipt)
  const fresh = e2e.tg.lastMessageId('sendRichMessage')
  expect(fresh).not.toBe(menuId)
  expect(await menuPointer()).toBe(fresh)
  expectNoErrors(e2e.logs)
})

test('a receipt edited into a menu stops being tracked as the last notification', async () => {
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})
  await e2e.send(privateCommand('/wallet'))
  const menuId = e2e.tg.lastMessageId('sendRichMessage')
  await e2e.container.notifier.send(USER_A, 'bot added to your chat', {
    reply_markup: {
      inline_keyboard: [
        [{text: 'Chat settings', callback_data: chatRoute.build({chatId: CHAT_GROUP})}],
      ],
    },
  })
  const receipt = e2e.tg.lastMessageId('sendMessage')
  if (receipt === undefined) throw new Error('no receipt was sent')
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(chatRoute.build({chatId: CHAT_GROUP}), {messageId: receipt}))

  // The receipt is now the menu: the previous menu is gone and the pointer moved onto it.
  expect(methodsSince(mark)).toContain('editMessageText')
  expect(deletedIdsSince(mark)).toEqual([menuId])
  expect(await menuPointer()).toBe(receipt)
  const user = await e2e.container.users.findById(USER_A)
  expect(user?.lastNotificationMessageId).toBeNull()
  expect(user?.lastNotificationBaseMarkup).toBeNull()

  // A later notification must not try to restore the receipt keyboard onto what is now a menu.
  const afterAdoption = e2e.tg.calls.length
  await e2e.container.notifier.send(USER_A, 'another receipt')
  expect(
    e2e.tg.calls
      .slice(afterAdoption)
      .filter(call => call.method === 'editMessageReplyMarkup')
      .map(call => call.payload.message_id),
  ).not.toContain(receipt)
  expectNoErrors(e2e.logs)
})

test('a private error carries the open-menu button and spawns no menu of its own', async () => {
  await seedUser(e2e, {id: OWNER, username: 'owner', firstName: 'Owner'})
  const mark = e2e.tg.calls.length

  // attachUser rejects bot senders before a handler can create a menu.
  await e2e.send(privateText('hello', {from: {id: OWNER, is_bot: true}}))

  const error = e2e.tg.of('sendMessage').at(-1)
  expect(String(error?.text)).toMatch(/can't send from a bot/i)
  expect(error?.reply_markup).toEqual({
    inline_keyboard: [[{text: '👛 Open wallet', callback_data: staticCallback.openMenu}]],
  })
  expect(methodsSince(mark)).not.toContain('sendRichMessage')
})

test('open-menu on an error deletes the error instead of only stripping its button', async () => {
  await e2e.send(privateText(mintInvoice({sats: 100, description: 'too expensive'}).bolt11))
  const error = e2e.tg.lastMessageId('sendMessage')
  expect(error).toBeDefined()
  const mark = e2e.tg.calls.length

  await e2e.send(privateCallback(staticCallback.openMenu, {messageId: error}))

  // A transient notice is disposable: nothing of it is worth keeping once the menu is back.
  expect(deletedIdsSince(mark)).toContain(error)
  expect(await notificationPointer()).toBeNull()
})

test('a later notification deletes the error it supersedes', async () => {
  await e2e.send(privateText(mintInvoice({sats: 100, description: 'too expensive'}).bolt11))
  const error = e2e.tg.lastMessageId('sendMessage')
  expect(error).toBeDefined()
  const mark = e2e.tg.calls.length

  await e2e.container.notifier.send(USER_A, 'you received sats')

  expect(deletedIdsSince(mark)).toContain(error)
  expect(methodsSince(mark)).not.toContain('editMessageReplyMarkup')
  expect(await notificationPointer()).toBe(e2e.tg.lastMessageId('sendMessage'))
})

// --- Helpers ---

async function menuPointer(): Promise<number | null | undefined> {
  return (await e2e.container.users.findById(USER_A))?.lastMenuMessageId
}

async function notificationPointer(): Promise<number | null | undefined> {
  return (await e2e.container.users.findById(USER_A))?.lastNotificationMessageId
}

function methodsSince(mark: number): string[] {
  return e2e.tg.calls.slice(mark).map(call => call.method)
}

function deletedIdsSince(mark: number): unknown[] {
  return e2e.tg.calls
    .slice(mark)
    .filter(call => call.method === 'deleteMessage')
    .map(call => call.payload.message_id)
}

function keyboardOfLastSend(): unknown {
  const markup = e2e.tg.last('sendMessage')?.reply_markup
  if (!markup || typeof markup !== 'object') return undefined
  return Reflect.get(markup, 'inline_keyboard')
}
