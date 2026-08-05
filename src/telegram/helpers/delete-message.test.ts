import {expect, mock, test} from 'bun:test'
import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {GrammyError} from 'grammy'
import {deleteMessageSafely, deleteMessagesSafely} from './delete-message.js'

function grammyDeleteError(method: 'deleteMessage' | 'deleteMessages') {
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
  partial: Partial<Context> & {
    deleteMessage?: Context['deleteMessage']
    deleteMessages?: Context['deleteMessages']
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
