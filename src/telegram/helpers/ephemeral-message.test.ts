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

function botNotAdminError() {
  return new GrammyError(
    "Call to 'sendMessage' failed! (400: Bad Request: BOT_NOT_ADMIN)",
    {ok: false, error_code: 400, description: 'Bad Request: BOT_NOT_ADMIN'},
    'sendMessage',
    {},
  )
}

function ctxWithLog(partial: {
  message?: {message_id: number; ephemeral_message_id?: number}
  from?: {id: number; is_bot?: boolean}
  msg?: {sender_chat?: {id: number; type: string; title: string}}
  reply?: Context['reply']
  deleteMessages?: Context['deleteMessages']
  api?: {deleteEphemeralMessage?: Context['api']['deleteEphemeralMessage']}
  log?: Partial<Pick<AppLogger, 'warn' | 'info'>>
}) {
  const {log = {}, ...rest} = partial
  return {
    log: {warn: mock(() => {}), info: mock(() => {}), ...log},
    ...rest,
  } as unknown as Context & {log: AppLogger}
}

function sentMessage(messageId: number) {
  return Promise.resolve({message_id: messageId} as Awaited<ReturnType<Context['reply']>>)
}

function ephemeralSentMessage(chatId: number, ephemeralMessageId: number) {
  return Promise.resolve({
    message_id: 0,
    chat: {id: chatId},
    ephemeral_message_id: ephemeralMessageId,
  } as Awaited<ReturnType<Context['reply']>>)
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

test('an ephemeral notice is deleted after the temp-message delay', async () => {
  const reply = mock(() => ephemeralSentMessage(-100, 9)) as unknown as Context['reply']
  const deleteEphemeralMessage = mock(() => Promise.resolve(true as const))

  await replyOnlyToSender(
    ctxWithLog({from: {id: 42}, reply, api: {deleteEphemeralMessage}}),
    'nope',
    {delayMs: 1},
  )

  expect(deleteEphemeralMessage).not.toHaveBeenCalled()
  await Bun.sleep(20)
  expect(deleteEphemeralMessage).toHaveBeenCalledWith(-100, 42, 9)
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

test('without admin rights the notice is a plain reply to the command', async () => {
  const info = mock(() => {})
  const warn = mock(() => {})
  const reply = mock((_text: string, other?: {receiver_user_id?: number}) =>
    other?.receiver_user_id === undefined ? sentMessage(8) : Promise.reject(botNotAdminError()),
  ) as unknown as Context['reply']
  const deleteMessages = mock(() => Promise.resolve(true as const))

  const delivered = await replyOnlyToSender(
    ctxWithLog({
      from: {id: 42},
      message: {message_id: 5},
      reply,
      deleteMessages,
      log: {info, warn},
    }),
    'nope',
    {delayMs: 1},
  )

  expect(delivered).toBe(true)
  expect(reply).toHaveBeenLastCalledWith('nope', {
    reply_parameters: {message_id: 5, allow_sending_without_reply: true},
  })
  expect(warn).not.toHaveBeenCalled()
  expect(info).toHaveBeenCalled()
})

test('an ephemeral command has no anchor for the fallback reply', async () => {
  const reply = mock((_text: string, other?: {receiver_user_id?: number}) =>
    other?.receiver_user_id === undefined ? sentMessage(8) : Promise.reject(botNotAdminError()),
  ) as unknown as Context['reply']

  await replyOnlyToSender(
    ctxWithLog({
      from: {id: 42},
      message: {message_id: 0, ephemeral_message_id: 3},
      reply,
      deleteMessages: mock(() => Promise.resolve(true as const)),
    }),
    'nope',
    {delayMs: 1},
  )

  expect(reply).toHaveBeenLastCalledWith('nope', undefined)
})

test('when every reply is refused the helper reports it instead of throwing', async () => {
  const reply = mock(() => Promise.reject(botNotAdminError())) as unknown as Context['reply']

  const delivered = await replyOnlyToSender(ctxWithLog({from: {id: 42}, reply}), 'nope')

  expect(delivered).toBe(false)
})
