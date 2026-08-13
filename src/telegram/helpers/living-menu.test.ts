import {expect, mock, test} from 'bun:test'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from './living-menu.js'
import type {NotificationChrome} from './notification-chrome.js'

function chromeMock(): NotificationChrome {
  return {
    stripLastOpenMenu: mock(() => Promise.resolve()),
    deliver: mock(() => Promise.reject(new Error('unused'))),
    deleteLivingMenu: mock(() => Promise.resolve()),
    rememberLivingMenu: mock(() => Promise.resolve()),
  }
}

test('showLivingMenu deletes the user message, previous menu, strips the notification, then sends', async () => {
  const chrome = chromeMock()
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const send = mock(() => Promise.resolve({message_id: 99}))
  const ctx = {
    user: {id: 1},
    msg: {message_id: 3},
    deleteMessage,
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  const sent = await showLivingMenu(ctx, send, chrome)

  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(chrome.deleteLivingMenu).toHaveBeenCalledWith(1)
  expect(chrome.stripLastOpenMenu).toHaveBeenCalledWith(1)
  expect(send).toHaveBeenCalledTimes(1)
  expect(chrome.rememberLivingMenu).toHaveBeenCalledWith(1, 99)
  expect(sent.message_id).toBe(99)
})

test('showLivingMenu does not delete the host when the update is a callback', async () => {
  const chrome = chromeMock()
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const send = mock(() => Promise.resolve({message_id: 8}))
  const ctx = {
    user: {id: 2},
    callbackQuery: {id: 'q', data: 'open-menu'},
    msg: {message_id: 5},
    deleteMessage,
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await showLivingMenu(ctx, send, chrome)

  expect(deleteMessage).not.toHaveBeenCalled()
  expect(chrome.deleteLivingMenu).toHaveBeenCalledWith(2)
  expect(chrome.stripLastOpenMenu).toHaveBeenCalledWith(2)
  expect(chrome.rememberLivingMenu).toHaveBeenCalledWith(2, 8)
})

test('showLivingMenu still sends when leftover menu cleanup rejects', async () => {
  const chrome = chromeMock()
  chrome.deleteLivingMenu = mock(() => Promise.reject(new Error('message to delete not found')))
  chrome.stripLastOpenMenu = mock(() => Promise.reject(new Error('message to edit not found')))
  chrome.rememberLivingMenu = mock(() => Promise.reject(new Error('db locked')))
  const send = mock(() => Promise.resolve({message_id: 99}))
  const ctx = {
    user: {id: 1},
    callbackQuery: {id: 'q'},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(showLivingMenu(ctx, send, chrome)).resolves.toEqual({message_id: 99})
  expect(send).toHaveBeenCalledTimes(1)
})
