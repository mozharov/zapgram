import {expect, test} from 'bun:test'
import {GrammyError, HttpError} from 'grammy'
import {isMessageToDeleteNotFound, isVanishedTelegramMessageError} from './vanished-message.js'

function grammy(method: string, description: string, errorCode = 400) {
  return new GrammyError(
    `Call to '${method}' failed! (${errorCode}: ${description})`,
    {
      ok: false,
      error_code: errorCode,
      description,
    },
    method,
    {},
  )
}

test('delete and markup cleanup failures are vanished-message errors', () => {
  expect(
    isVanishedTelegramMessageError(
      grammy('deleteMessage', 'Bad Request: message to delete not found'),
    ),
  ).toBe(true)
  expect(
    isVanishedTelegramMessageError(
      grammy('editMessageReplyMarkup', 'Bad Request: message to edit not found'),
    ),
  ).toBe(true)
})

test('a domain or unknown error is not a vanished-message error', () => {
  expect(isVanishedTelegramMessageError(new Error('nope'))).toBe(false)
  expect(isVanishedTelegramMessageError(grammy('sendMessage', 'Bad Request: chat not found'))).toBe(
    false,
  )
})

test('a delete that Telegram did not refuse as gone is not a vanished message', () => {
  expect(
    isVanishedTelegramMessageError(
      grammy('deleteMessage', 'Too Many Requests: retry after 1', 429),
    ),
  ).toBe(false)
  expect(
    isVanishedTelegramMessageError(grammy('deleteMessage', 'Internal Server Error', 500)),
  ).toBe(false)
  expect(
    isVanishedTelegramMessageError(
      new HttpError('Network request for deleteMessage failed!', new Error('reset')),
    ),
  ).toBe(false)
})

test('only "message to delete not found" means the offer is already gone', () => {
  expect(
    isMessageToDeleteNotFound(grammy('deleteMessage', 'Bad Request: message to delete not found')),
  ).toBe(true)
  expect(
    isMessageToDeleteNotFound(grammy('deleteMessage', "Bad Request: message can't be deleted")),
  ).toBe(false)
  expect(
    isMessageToDeleteNotFound(grammy('deleteMessage', 'Too Many Requests: retry after 1', 429)),
  ).toBe(false)
  expect(isMessageToDeleteNotFound(grammy('deleteMessage', 'Internal Server Error', 500))).toBe(
    false,
  )
  expect(isMessageToDeleteNotFound(new Error('socket hang up'))).toBe(false)
})
