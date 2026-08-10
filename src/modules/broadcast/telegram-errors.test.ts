import {expect, test} from 'bun:test'
import {GrammyError} from 'grammy'
import {isTelegramUserUnreachableError, telegramErrorMessage} from './telegram-errors.js'

function grammy(error_code: number, description: string) {
  return new GrammyError(
    `Call failed! (${error_code}: ${description})`,
    {
      ok: false,
      error_code,
      description,
    },
    'copyMessage',
    {},
  )
}

test('isTelegramUserUnreachableError detects blocked, deactivated, no-chat, cannot-initiate', () => {
  expect(
    isTelegramUserUnreachableError(grammy(403, 'Forbidden: bot was blocked by the user')),
  ).toBe(true)
  expect(isTelegramUserUnreachableError(grammy(403, 'Forbidden: user is deactivated'))).toBe(true)
  expect(
    isTelegramUserUnreachableError(
      grammy(403, "Forbidden: bot can't initiate conversation with a user"),
    ),
  ).toBe(true)
  expect(
    isTelegramUserUnreachableError(
      grammy(403, 'Forbidden: bot cannot initiate conversation with a user'),
    ),
  ).toBe(true)
  expect(isTelegramUserUnreachableError(grammy(400, 'Bad Request: chat not found'))).toBe(true)
  expect(isTelegramUserUnreachableError(grammy(403, 'Forbidden: other'))).toBe(false)
  expect(
    isTelegramUserUnreachableError(grammy(400, 'Bad Request: message to copy not found')),
  ).toBe(false)
  expect(isTelegramUserUnreachableError(grammy(400, 'Bad Request'))).toBe(false)
  expect(isTelegramUserUnreachableError(new Error('nope'))).toBe(false)
})

test('telegramErrorMessage truncates long descriptions', () => {
  const long = 'x'.repeat(300)
  expect(telegramErrorMessage(grammy(400, long)).length).toBeLessThanOrEqual(200)
})
