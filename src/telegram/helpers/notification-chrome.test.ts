import {expect, mock, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {staticCallback} from '@telegram/callback-data.js'
import {createTestDb} from '@test/helpers/db.js'
import {createNotificationChrome} from './notification-chrome.js'

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
