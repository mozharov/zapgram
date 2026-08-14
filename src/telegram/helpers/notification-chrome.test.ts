import {expect, mock, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {staticCallback} from '@telegram/callback-data.js'
import {createTestDb} from '@test/helpers/db.js'
import {createChromeNotifier, createNotificationChrome} from './notification-chrome.js'

function setup() {
  const users = createUserRepository(createTestDb())
  const editMessageReplyMarkup = mock(() => Promise.resolve(true as const))
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})
  const chrome = createNotificationChrome({
    findUser: id => users.findById(id),
    updateUser: (id, data) => users.update(id, data),
    editMessageReplyMarkup,
    deleteMessage,
    log: {warn} as never,
  })
  return {users, chrome, editMessageReplyMarkup, deleteMessage, warn}
}

test('deliver appends open-menu to an empty keyboard and remembers the message', async () => {
  const {users, chrome} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})

  const send = mock((markup: {inline_keyboard: unknown[]}) =>
    Promise.resolve({message_id: 10, markup}),
  )
  const sent = await chrome.deliver(1, undefined, send)

  expect(sent.message_id).toBe(10)
  const markup = send.mock.calls[0]?.[0]
  expect(markup?.inline_keyboard).toEqual([
    [{text: '👛 Open wallet', callback_data: staticCallback.openMenu}],
  ])
  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBe(10)
  expect(user?.lastNotificationBaseMarkup).toBeNull()
})

test('a second deliver strips the previous open-menu and restores the base keyboard', async () => {
  const {users, chrome, editMessageReplyMarkup} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})

  const payRow = [{text: 'Pay', callback_data: 'pay'}]
  await chrome.deliver(1, {inline_keyboard: [payRow]}, () => Promise.resolve({message_id: 10}))
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 11}))

  expect(editMessageReplyMarkup).toHaveBeenCalledWith(1, 10, {
    reply_markup: {inline_keyboard: [payRow]},
  })
  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBe(11)
})

test('deliver still sends when the previous notification is already gone', async () => {
  const {users, chrome, editMessageReplyMarkup, warn} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastNotificationMessageId: 9, lastNotificationBaseMarkup: null})
  editMessageReplyMarkup.mockImplementationOnce(() =>
    Promise.reject(new Error('message to edit not found')),
  )

  const sent = await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 20}))

  expect(sent.message_id).toBe(20)
  expect(warn).toHaveBeenCalled()
  expect((await users.findById(1))?.lastNotificationMessageId).toBe(20)
})

test('a failed send does not move last-notification pointers', async () => {
  const {users, chrome} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastNotificationMessageId: 7, lastNotificationBaseMarkup: null})

  await expect(
    chrome.deliver(1, undefined, () => Promise.reject(new Error('telegram down'))),
  ).rejects.toThrow('telegram down')

  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBe(7)
})

test('stripLastOpenMenu forgets the pointer on success, so a replay does not re-edit', async () => {
  const {users, chrome, editMessageReplyMarkup} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastNotificationMessageId: 9, lastNotificationBaseMarkup: null})

  await chrome.stripLastOpenMenu(1)
  expect(editMessageReplyMarkup).toHaveBeenCalledTimes(1)
  expect((await users.findById(1))?.lastNotificationMessageId).toBeNull()

  await chrome.stripLastOpenMenu(1)
  expect(editMessageReplyMarkup).toHaveBeenCalledTimes(1)
})

test('stripLastOpenMenu swallows a vanished message and forgets the pointer', async () => {
  const {users, chrome, editMessageReplyMarkup, warn} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastNotificationMessageId: 9, lastNotificationBaseMarkup: null})
  editMessageReplyMarkup.mockImplementationOnce(() =>
    Promise.reject(new Error('message to edit not found')),
  )

  await expect(chrome.stripLastOpenMenu(1)).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalled()
  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBeNull()
  expect(user?.lastNotificationBaseMarkup).toBeNull()
})

test('adoptLivingMenu is a no-op when the clicked message is already the living menu', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastMenuMessageId: 4})

  await chrome.adoptLivingMenu(1, 4)

  expect(deleteMessage).not.toHaveBeenCalled()
  expect((await users.findById(1))?.lastMenuMessageId).toBe(4)
})

test('adoptLivingMenu deletes the tracked menu and re-points at the clicked message', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastMenuMessageId: 4})

  await chrome.adoptLivingMenu(1, 9)

  expect(deleteMessage).toHaveBeenCalledWith(1, 4)
  expect((await users.findById(1))?.lastMenuMessageId).toBe(9)
})

test('adoptLivingMenu records the clicked message when no menu is tracked', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})

  await chrome.adoptLivingMenu(1, 9)

  expect(deleteMessage).not.toHaveBeenCalled()
  expect((await users.findById(1))?.lastMenuMessageId).toBe(9)
})

test('adoptLivingMenu forgets the notification when the receipt becomes the menu', async () => {
  const {users, chrome} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.deliver(1, {inline_keyboard: [[{text: 'Chat', callback_data: 'chat:-1'}]]}, () =>
    Promise.resolve({message_id: 10}),
  )

  await chrome.adoptLivingMenu(1, 10)

  const user = await users.findById(1)
  expect(user?.lastMenuMessageId).toBe(10)
  expect(user?.lastNotificationMessageId).toBeNull()
  expect(user?.lastNotificationBaseMarkup).toBeNull()
})

test('adoptLivingMenu still re-points when deleting the tracked menu fails', async () => {
  const {users, chrome, deleteMessage, warn} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastMenuMessageId: 4})
  deleteMessage.mockImplementationOnce(() =>
    Promise.reject(new Error('message to delete not found')),
  )

  await expect(chrome.adoptLivingMenu(1, 9)).resolves.toBeUndefined()

  expect(warn).toHaveBeenCalled()
  expect((await users.findById(1))?.lastMenuMessageId).toBe(9)
})

test('adoptLivingMenu swallows a failed persist', async () => {
  const users = createUserRepository(createTestDb())
  await users.getOrCreate({id: 1, languageCode: 'en'})
  const chromeWithFailingUpdate = createNotificationChrome({
    findUser: id => users.findById(id),
    updateUser: mock(() => Promise.reject(new Error('db locked'))),
    editMessageReplyMarkup: mock(() => Promise.resolve(true as const)),
    deleteMessage: mock(() => Promise.resolve(true as const)),
    log: {warn: mock(() => {})} as never,
  })

  await expect(chromeWithFailingUpdate.adoptLivingMenu(1, 12)).resolves.toBeUndefined()
})

test('deliver marked transient is deleted, not stripped, once superseded', async () => {
  const {users, chrome, editMessageReplyMarkup, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})

  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 10}), {transient: true})
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 11}))

  expect(deleteMessage).toHaveBeenCalledWith(1, 10)
  expect(editMessageReplyMarkup).not.toHaveBeenCalled()
  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBe(11)
})

test('stripLastOpenMenu deletes a transient notification and forgets the pointer', async () => {
  const {users, chrome, editMessageReplyMarkup, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 9}), {transient: true})

  await chrome.stripLastOpenMenu(1)

  expect(deleteMessage).toHaveBeenCalledWith(1, 9)
  expect(editMessageReplyMarkup).not.toHaveBeenCalled()
  const user = await users.findById(1)
  expect(user?.lastNotificationMessageId).toBeNull()
})

test('retireMenuAsNotification resets the transient flag so a later strip does not delete a receipt', async () => {
  const {users, chrome, editMessageReplyMarkup, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 5}), {transient: true})
  await chrome.stripLastOpenMenu(1)
  expect(deleteMessage).toHaveBeenCalledWith(1, 5)

  await chrome.retireMenuAsNotification(1, 20, markup => Promise.resolve({markup}))
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 21}))

  expect(editMessageReplyMarkup).toHaveBeenCalledWith(1, 20, {reply_markup: {inline_keyboard: []}})
  expect(deleteMessage).toHaveBeenCalledTimes(1)
})

test('adoptLivingMenu is idempotent, so a replayed send does not delete the message it tracks', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastMenuMessageId: 4})

  // First pass: a new menu 9 supersedes menu 4.
  await chrome.adoptLivingMenu(1, 9)
  expect(deleteMessage).toHaveBeenCalledTimes(1)

  // Conversation replay: the same send() returns 9 again. Nothing may be deleted this time.
  await chrome.adoptLivingMenu(1, 9)
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect((await users.findById(1))?.lastMenuMessageId).toBe(9)
})

test('notifier send with withoutMenu bypasses the chrome and appends no open-menu row', async () => {
  const {users, chrome, editMessageReplyMarkup} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.deliver(1, undefined, () => Promise.resolve({message_id: 10}))
  editMessageReplyMarkup.mockClear()

  const sendMessage = mock(() => Promise.resolve({message_id: 11}))
  const notifier = createChromeNotifier(
    {sendMessage} as never,
    {error: mock(() => {})} as never,
    chrome,
  )

  expect(await notifier.send(1, 'Access granted', undefined, {withoutMenu: true})).toBe(true)
  expect(sendMessage).toHaveBeenCalledWith(1, 'Access granted', undefined)
  // The previous receipt keeps its button, and the pointer still names it.
  expect(editMessageReplyMarkup).not.toHaveBeenCalled()
  expect((await users.findById(1))?.lastNotificationMessageId).toBe(10)
})

// --- The join payment screen: a second, temporary menu ---

test('a new join screen deletes the one the previous request left behind', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})

  await chrome.adoptJoinScreen(1, 30)
  expect(deleteMessage).not.toHaveBeenCalled()

  await chrome.adoptJoinScreen(1, 31)

  expect(deleteMessage).toHaveBeenCalledWith(1, 30)
  expect((await users.findById(1))?.lastJoinMessageId).toBe(31)
})

test('a re-sent join screen with the same id deletes nothing', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.adoptJoinScreen(1, 30)

  await chrome.adoptJoinScreen(1, 30)

  expect(deleteMessage).not.toHaveBeenCalled()
  expect((await users.findById(1))?.lastJoinMessageId).toBe(30)
})

test('a new menu deletes both the previous menu and the join screen on top of it', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.adoptLivingMenu(1, 5)
  await chrome.adoptJoinScreen(1, 30)

  await chrome.adoptLivingMenu(1, 6)

  expect(deleteMessage).toHaveBeenCalledWith(1, 30)
  expect(deleteMessage).toHaveBeenCalledWith(1, 5)
  const user = await users.findById(1)
  expect(user?.lastMenuMessageId).toBe(6)
  expect(user?.lastJoinMessageId).toBeNull()
})

test('repainting the same menu in place still clears the join screen', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.adoptLivingMenu(1, 5)
  await chrome.adoptJoinScreen(1, 30)

  // A callback edits menu 5 and re-adopts it: the equal-id early return must not skip the drop.
  await chrome.adoptLivingMenu(1, 5)

  expect(deleteMessage).toHaveBeenCalledWith(1, 30)
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  const user = await users.findById(1)
  expect(user?.lastMenuMessageId).toBe(5)
  expect(user?.lastJoinMessageId).toBeNull()
})

test('a forgotten join screen is left in the chat by the next menu', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.adoptJoinScreen(1, 30)

  // Settled: message 30 is the member's proof of access now, not a payment screen.
  await chrome.forgetJoinScreen(1, 30)
  await chrome.adoptLivingMenu(1, 6)

  expect(deleteMessage).not.toHaveBeenCalled()
  expect((await users.findById(1))?.lastJoinMessageId).toBeNull()
})

test('forgetting a join screen the pointer no longer names changes nothing', async () => {
  const {users, chrome} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await chrome.adoptJoinScreen(1, 31)

  await chrome.forgetJoinScreen(1, 30)

  expect((await users.findById(1))?.lastJoinMessageId).toBe(31)
})
