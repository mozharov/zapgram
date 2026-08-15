import {expect, test} from 'bun:test'
import type {Context} from 'grammy'
import {
  ephemeralReceiverUserId,
  GROUP_ANONYMOUS_BOT_ID,
  isIdentifiableHumanSender,
} from './identifiable-sender.js'

function ctx(partial: {
  from?: {id: number; is_bot?: boolean}
  msg?: {sender_chat?: {id: number; type: string; title: string}}
}) {
  return partial as unknown as Context
}

test('a normal human group member is identifiable', () => {
  const c = ctx({from: {id: 42, is_bot: false}})
  expect(isIdentifiableHumanSender(c)).toBe(true)
  expect(ephemeralReceiverUserId(c)).toBe(42)
})

test('a bot account is not identifiable', () => {
  const c = ctx({from: {id: 99, is_bot: true}})
  expect(isIdentifiableHumanSender(c)).toBe(false)
  expect(ephemeralReceiverUserId(c)).toBeUndefined()
})

test('Group Anonymous Bot is not identifiable', () => {
  const c = ctx({from: {id: GROUP_ANONYMOUS_BOT_ID, is_bot: true}})
  expect(isIdentifiableHumanSender(c)).toBe(false)
  expect(ephemeralReceiverUserId(c)).toBeUndefined()
})

test('send-as channel (sender_chat) is not identifiable even with a non-bot from', () => {
  const c = ctx({
    from: {id: -100123, is_bot: false},
    msg: {sender_chat: {id: -100123, type: 'channel', title: 'News'}},
  })
  expect(isIdentifiableHumanSender(c)).toBe(false)
  expect(ephemeralReceiverUserId(c)).toBeUndefined()
})

test('anonymous group admin (sender_chat = group) is not identifiable', () => {
  const c = ctx({
    from: {id: GROUP_ANONYMOUS_BOT_ID, is_bot: true},
    msg: {sender_chat: {id: -100999, type: 'supergroup', title: 'Chat'}},
  })
  expect(isIdentifiableHumanSender(c)).toBe(false)
  expect(ephemeralReceiverUserId(c)).toBeUndefined()
})

test('missing from is not identifiable', () => {
  expect(isIdentifiableHumanSender(ctx({}))).toBe(false)
  expect(ephemeralReceiverUserId(ctx({}))).toBeUndefined()
})
