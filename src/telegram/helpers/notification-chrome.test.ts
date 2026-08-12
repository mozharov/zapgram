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

test('deleteLivingMenu removes the stored menu message', async () => {
  const {users, chrome, deleteMessage} = setup()
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.update(1, {lastMenuMessageId: 4})

  await chrome.deleteLivingMenu(1)
  expect(deleteMessage).toHaveBeenCalledWith(1, 4)
})
