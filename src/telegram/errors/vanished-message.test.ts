import {expect, test} from 'bun:test'
import {GrammyError} from 'grammy'
import {isVanishedTelegramMessageError} from './vanished-message.js'

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
