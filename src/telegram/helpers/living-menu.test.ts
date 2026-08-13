import {expect, mock, test} from 'bun:test'
import type {BotContext} from '@telegram/context.js'
import {editLivingMenu, showLivingMenu} from './living-menu.js'
import type {NotificationChrome} from './notification-chrome.js'

function chromeMock(): NotificationChrome {
  return {
    stripLastOpenMenu: mock(() => Promise.resolve()),
    deliver: mock(() => Promise.reject(new Error('unused'))),
    adoptLivingMenu: mock(() => Promise.resolve()),
    retireMenuAsNotification: mock(() => Promise.reject(new Error('unused'))),
  }
}

test('showLivingMenu deletes the user message, strips the notification, sends, then adopts', async () => {
  const chrome = chromeMock()
  const calls: string[] = []
  chrome.stripLastOpenMenu = mock(() => {
    calls.push('strip')
    return Promise.resolve()
  })
  chrome.adoptLivingMenu = mock(() => {
    calls.push('adopt')
    return Promise.resolve()
  })
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const send = mock(() => {
    calls.push('send')
    return Promise.resolve({message_id: 99})
  })
  const ctx = {
    user: {id: 1},
    msg: {message_id: 3},
    deleteMessage,
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  const sent = await showLivingMenu(ctx, send, chrome)

  expect(deleteMessage).toHaveBeenCalledTimes(1)
  // Sending before adopting is what makes a conversation replay a no-op instead of a lost prompt.
  expect(calls).toEqual(['strip', 'send', 'adopt'])
  expect(chrome.stripLastOpenMenu).toHaveBeenCalledWith(1)
  expect(chrome.adoptLivingMenu).toHaveBeenCalledWith(1, 99)
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
  expect(chrome.stripLastOpenMenu).toHaveBeenCalledWith(2)
  expect(chrome.adoptLivingMenu).toHaveBeenCalledWith(2, 8)
})

test('editLivingMenu edits first, then adopts the clicked message as the living menu', async () => {
  const chrome = chromeMock()
  const calls: string[] = []
  chrome.adoptLivingMenu = mock(() => {
    calls.push('adopt')
    return Promise.resolve()
  })
  const edit = mock(() => {
    calls.push('edit')
    return Promise.resolve('edited')
  })
  const ctx = {
    user: {id: 7},
    callbackQuery: {id: 'q', message: {message_id: 42}},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(editLivingMenu(ctx, edit, chrome)).resolves.toBe('edited')

  expect(calls).toEqual(['edit', 'adopt'])
  expect(chrome.adoptLivingMenu).toHaveBeenCalledWith(7, 42)
})

test('editLivingMenu does not adopt when the edit fails', async () => {
  const chrome = chromeMock()
  const edit = mock(() => Promise.reject(new Error('message to edit not found')))
  const ctx = {
    user: {id: 7},
    callbackQuery: {id: 'q', message: {message_id: 42}},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(editLivingMenu(ctx, edit, chrome)).rejects.toThrow('message to edit not found')
  expect(chrome.adoptLivingMenu).not.toHaveBeenCalled()
})

test('editLivingMenu skips bookkeeping without a callback message', async () => {
  const chrome = chromeMock()
  const edit = mock(() => Promise.resolve('edited'))
  const ctx = {
    user: {id: 7},
    callbackQuery: {id: 'q'},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(editLivingMenu(ctx, edit, chrome)).resolves.toBe('edited')
  expect(chrome.adoptLivingMenu).not.toHaveBeenCalled()
})

test('editLivingMenu still resolves when adoption rejects', async () => {
  const chrome = chromeMock()
  chrome.adoptLivingMenu = mock(() => Promise.reject(new Error('db locked')))
  const ctx = {
    user: {id: 7},
    callbackQuery: {id: 'q', message: {message_id: 42}},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(editLivingMenu(ctx, () => Promise.resolve('edited'), chrome)).resolves.toBe('edited')
})

test('showLivingMenu still sends when leftover menu cleanup rejects', async () => {
  const chrome = chromeMock()
  chrome.stripLastOpenMenu = mock(() => Promise.reject(new Error('message to edit not found')))
  chrome.adoptLivingMenu = mock(() => Promise.reject(new Error('db locked')))
  const send = mock(() => Promise.resolve({message_id: 99}))
  const ctx = {
    user: {id: 1},
    callbackQuery: {id: 'q'},
    log: {warn: mock(() => {})},
  } as unknown as BotContext

  await expect(showLivingMenu(ctx, send, chrome)).resolves.toEqual({message_id: 99})
  expect(send).toHaveBeenCalledTimes(1)
})
