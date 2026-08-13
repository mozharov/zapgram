import {afterEach, beforeEach, expect, test} from 'bun:test'
import {createE2E, type E2E} from '../harness.js'
import {USER_A} from './ids.js'
import {
  chatJoinRequest,
  groupReply,
  groupReplyToChannel,
  groupText,
  myChatMember,
  newChatTitle,
  privateCallback,
  privateCommand,
  privatePhotoCaptionCallback,
  privateText,
} from './updates.js'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('all update factories produce updates accepted by the real bot', async () => {
  const updates = [
    privateText('hello'),
    privateCommand('/wallet'),
    privateCallback('unknown-route'),
    privatePhotoCaptionCallback('unknown-photo-route'),
    groupText('hello group'),
    groupReply('/tip 21', {text: 'reply target'}),
    groupReplyToChannel('/tip 21'),
    myChatMember('supergroup', true),
    chatJoinRequest('channel'),
    newChatTitle('Renamed E2E Group'),
  ]

  for (const update of updates) await e2e.send(update)

  expect(updates.every(update => typeof update.reqId === 'string')).toBe(true)
})

test('privateCommand uses the full command length and supports a manual update id', () => {
  const update = privateCommand('/wallet', {updateId: 4242, reqId: 'manual-request'})
  expect(update.update_id).toBe(4242)
  expect(update.reqId).toBe('manual-request')
  expect(update.message?.entities).toEqual([
    {type: 'bot_command', offset: 0, length: '/wallet'.length},
  ])
})

test('privateCallback can target the message id returned for an outbound prompt', async () => {
  const prompt = await e2e.container.bot.api.sendMessage(USER_A, 'Choose an action')
  const promptMessageId = e2e.tg.lastMessageId('sendMessage')
  const callback = privateCallback('choose-action', {messageId: promptMessageId})

  expect(promptMessageId).toBe(prompt.message_id)
  expect(callback.callback_query?.message?.message_id).toBe(prompt.message_id)
})
