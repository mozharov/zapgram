import {expect, mock, test} from 'bun:test'
import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {GrammyError} from 'grammy'
import {replyOnlyToSender} from './ephemeral-message.js'

function grammyReplyError() {
  return new GrammyError(
    "Call to 'sendMessage' failed! (400: Bad Request: user not found)",
    {ok: false, error_code: 400, description: 'Bad Request: user not found'},
    'sendMessage',
    {},
  )
}

function ctxWithLog(partial: {
  from?: {id: number; is_bot?: boolean}
  msg?: {sender_chat?: {id: number; type: string; title: string}}
  reply?: Context['reply']
  deleteMessages?: Context['deleteMessages']
  log?: Pick<AppLogger, 'warn'>
}) {
  const {log = {warn: mock(() => {})}, ...rest} = partial
  return {log, ...rest} as unknown as Context & {log: AppLogger}
}

function sentMessage(messageId: number) {
  return Promise.resolve({message_id: messageId} as Awaited<ReturnType<Context['reply']>>)
}

test('the notice is an ephemeral message addressed to the sender', async () => {
  const reply = mock(() => sentMessage(1)) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(ctxWithLog({from: {id: 42}, reply, deleteMessages}), 'nope', {
    other: {parse_mode: 'HTML'},
  })

  expect(reply).toHaveBeenCalledWith('nope', {parse_mode: 'HTML', receiver_user_id: 42})
  await Bun.sleep(5)
  expect(deleteMessages).not.toHaveBeenCalled()
})

test('a refused ephemeral message falls back to a public temp message', async () => {
  const error = grammyReplyError()
  const warn = mock(() => {})
  const reply = mock((_text: string, other?: {receiver_user_id?: number}) =>
    other?.receiver_user_id === undefined ? sentMessage(7) : Promise.reject(error),
  ) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(
    ctxWithLog({from: {id: 42}, reply, deleteMessages, log: {warn}}),
    'nope',
    {
      delayMs: 1,
      other: {parse_mode: 'HTML'},
    },
  )

  expect(reply).toHaveBeenLastCalledWith('nope', {parse_mode: 'HTML'})
  expect(warn).toHaveBeenCalledWith({error, receiverUserId: 42}, 'Failed to send ephemeral message')
  // The public fallback owns its own cleanup — the ephemeral path has nothing to delete.
  await Bun.sleep(20)
  expect(deleteMessages).toHaveBeenCalledWith([7])
})

test('an update with no sender goes straight to the public temp message', async () => {
  const reply = mock(() => sentMessage(9)) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(ctxWithLog({reply, deleteMessages}), 'nope', {delayMs: 1})

  expect(reply).toHaveBeenCalledWith('nope', undefined)
  await Bun.sleep(20)
  expect(deleteMessages).toHaveBeenCalledWith([9])
})

test('send-as channel skips ephemeral and uses the public temp message', async () => {
  const reply = mock(() => sentMessage(11)) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(
    ctxWithLog({
      from: {id: -100123, is_bot: false},
      msg: {sender_chat: {id: -100123, type: 'channel', title: 'News'}},
      reply,
      deleteMessages,
    }),
    'nope',
    {delayMs: 1},
  )

  // One public reply only — no receiver_user_id attempt for channel identity.
  expect(reply).toHaveBeenCalledTimes(1)
  expect(reply).toHaveBeenCalledWith('nope', undefined)
  await Bun.sleep(20)
  expect(deleteMessages).toHaveBeenCalledWith([11])
})

test('a bot from skips ephemeral and uses the public temp message', async () => {
  const reply = mock(() => sentMessage(13)) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(
    ctxWithLog({
      from: {id: 1087968824, is_bot: true},
      reply,
      deleteMessages,
    }),
    'nope',
    {delayMs: 1},
  )

  expect(reply).toHaveBeenCalledTimes(1)
  expect(reply).toHaveBeenCalledWith('nope', undefined)
  await Bun.sleep(20)
  expect(deleteMessages).toHaveBeenCalledWith([13])
})
