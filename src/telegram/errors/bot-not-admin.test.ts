import {expect, test} from 'bun:test'
import {GrammyError} from 'grammy'
import {isBotNotAdminError} from './bot-not-admin.js'

function grammyError(description: string) {
  return new GrammyError(
    `Call to 'sendMessage' failed! (400: ${description})`,
    {ok: false, error_code: 400, description},
    'sendMessage',
    {},
  )
}

test('BOT_NOT_ADMIN is recognised', () => {
  expect(isBotNotAdminError(grammyError('Bad Request: BOT_NOT_ADMIN'))).toBe(true)
})

test('other Telegram errors and plain errors are not', () => {
  expect(isBotNotAdminError(grammyError('Bad Request: chat not found'))).toBe(false)
  expect(isBotNotAdminError(new Error('BOT_NOT_ADMIN'))).toBe(false)
})
