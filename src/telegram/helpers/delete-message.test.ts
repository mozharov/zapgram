import {expect, mock, test} from 'bun:test'
import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {GrammyError} from 'grammy'
import {deleteMessageSafely, deleteMessagesSafely} from './delete-message.js'

function grammyDeleteError(method: 'deleteMessage' | 'deleteMessages' | 'deleteEphemeralMessage') {
  return new GrammyError(
    `Call to '${method}' failed! (400: Bad Request: message can't be deleted for everyone)`,
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: message can't be deleted for everyone",
    },
    method,
    {},
  )
}

function ctxWithLog(
  partial: {
    deleteMessage?: Context['deleteMessage']
    deleteMessages?: Context['deleteMessages']
    api?: {deleteEphemeralMessage?: Context['api']['deleteEphemeralMessage']}
    chat?: {id: number}
    from?: {id: number}
    msg?: {
      ephemeral_message_id?: number
      receiver_user?: {id: number}
      chat?: {id: number}
    }
  },
  log: Pick<AppLogger, 'warn'>,
) {
  return {log, ...partial} as unknown as Context & {log: AppLogger}
}

test('deleteMessageSafely swallows Telegram 400 and logs a warning', async () => {
  const error = grammyDeleteError('deleteMessage')
  const deleteMessage = mock(() => Promise.reject(error))
  const warn = mock(() => {})
  await expect(deleteMessageSafely(ctxWithLog({deleteMessage}, {warn}))).resolves.toBeUndefined()
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith({error}, 'Failed to delete message')
})

test('deleteMessageSafely resolves without logging when delete succeeds', async () => {
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})
  await expect(deleteMessageSafely(ctxWithLog({deleteMessage}, {warn}))).resolves.toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

test('deleteMessageSafely deletes an ephemeral command via deleteEphemeralMessage', async () => {
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const deleteEphemeralMessage = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})

  await deleteMessageSafely(
    ctxWithLog(
      {
        deleteMessage,
        api: {deleteEphemeralMessage},
        chat: {id: -100},
        from: {id: 42},
        msg: {ephemeral_message_id: 5, receiver_user: {id: 42}},
      },
      {warn},
    ),
  )

  expect(deleteEphemeralMessage).toHaveBeenCalledWith(-100, 42, 5)
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

test('deleteMessageSafely no-ops an ephemeral command when no receiver id is available', async () => {
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const deleteEphemeralMessage = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})

  await deleteMessageSafely(
    ctxWithLog(
      {
        deleteMessage,
        api: {deleteEphemeralMessage},
        chat: {id: -100},
        msg: {ephemeral_message_id: 5},
      },
      {warn},
    ),
  )

  expect(deleteEphemeralMessage).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

test('deleteMessageSafely swallows Telegram 400 from deleteEphemeralMessage', async () => {
  const error = grammyDeleteError('deleteEphemeralMessage')
  const deleteEphemeralMessage = mock(() => Promise.reject(error))
  const deleteMessage = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})

  await expect(
    deleteMessageSafely(
      ctxWithLog(
        {
          deleteMessage,
          api: {deleteEphemeralMessage},
          chat: {id: -100},
          from: {id: 42},
          msg: {ephemeral_message_id: 5},
        },
        {warn},
      ),
    ),
  ).resolves.toBeUndefined()
  expect(deleteEphemeralMessage).toHaveBeenCalledWith(-100, 42, 5)
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith({error}, 'Failed to delete message')
})

test('deleteMessagesSafely swallows Telegram 400 and logs a warning', async () => {
  const error = grammyDeleteError('deleteMessages')
  const deleteMessages = mock(() => Promise.reject(error))
  const warn = mock(() => {})
  await expect(
    deleteMessagesSafely(ctxWithLog({deleteMessages}, {warn}), [42]),
  ).resolves.toBeUndefined()
  expect(deleteMessages).toHaveBeenCalledWith([42])
  expect(warn).toHaveBeenCalledWith({error, messageIds: [42]}, 'Failed to delete messages')
})

test('deleteMessagesSafely is a no-op for an empty id list', async () => {
  const deleteMessages = mock(() => Promise.resolve(true as const))
  const warn = mock(() => {})
  await deleteMessagesSafely(ctxWithLog({deleteMessages}, {warn}), [])
  expect(deleteMessages).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})
