import {expect, test} from 'bun:test'
import {DEFAULT_TIP_SATS, matchTipRequest} from './tip-match.js'

const BOT = 'zap_gram_bot'

test('a plain /tip carries an optional amount and recipient', () => {
  expect(matchTipRequest('/tip', BOT)).toEqual({sats: DEFAULT_TIP_SATS, username: undefined})
  expect(matchTipRequest('/tip 100', BOT)).toEqual({sats: 100, username: undefined})
  expect(matchTipRequest('/tip 100 @user_b', BOT)).toEqual({sats: 100, username: 'user_b'})
  expect(matchTipRequest('/tip @UsEr_B', BOT)).toEqual({
    sats: DEFAULT_TIP_SATS,
    username: 'user_b',
  })
})

test('the bot suffix clients add in multi-bot chats is accepted in any case', () => {
  expect(matchTipRequest('/tip@zap_gram_bot 100 @user_b', BOT)).toEqual({
    sats: 100,
    username: 'user_b',
  })
  expect(matchTipRequest('/tip@ZAP_GRAM_BOT', BOT)).toEqual({
    sats: DEFAULT_TIP_SATS,
    username: undefined,
  })
  expect(matchTipRequest('/tip@zap_gram_bot', 'ZaP_GrAm_BoT')).toEqual({
    sats: DEFAULT_TIP_SATS,
    username: undefined,
  })
})

test('a bare mention of this bot is the same trigger', () => {
  expect(matchTipRequest('@zap_gram_bot 100 @user_b', BOT)).toEqual({
    sats: 100,
    username: 'user_b',
  })
  expect(matchTipRequest('@zap_gram_bot', BOT)).toEqual({
    sats: DEFAULT_TIP_SATS,
    username: undefined,
  })
})

test('another bot / another user is none of our business', () => {
  expect(matchTipRequest('/tip@other_bot 100 @user_b', BOT)).toBeNull()
  expect(matchTipRequest('@someone_else 100', BOT)).toBeNull()
  expect(matchTipRequest('@zap_gram_bot_clone 100', BOT)).toBeNull()
  expect(matchTipRequest('just chatting', BOT)).toBeNull()
  expect(matchTipRequest('/wallet', BOT)).toBeNull()
})

test('an unknown bot username only leaves the plain /tip trigger', () => {
  expect(matchTipRequest('/tip 100', undefined)).toEqual({sats: 100, username: undefined})
  expect(matchTipRequest('/tip@zap_gram_bot 100', undefined)).toBeNull()
  expect(matchTipRequest('@zap_gram_bot 100', undefined)).toBeNull()
})

test('arguments this bot cannot parse ask for the usage hint', () => {
  expect(matchTipRequest('/tip twenty @user_b', BOT)).toBe('invalid')
  expect(matchTipRequest('/tip 100 @user_b extra', BOT)).toBe('invalid')
  expect(matchTipRequest('/tip100', BOT)).toBe('invalid')
  expect(matchTipRequest('/tipping is nice', BOT)).toBe('invalid')
  expect(matchTipRequest('/tip@zap_gram_bot twenty', BOT)).toBe('invalid')
  expect(matchTipRequest('@zap_gram_bot twenty', BOT)).toBe('invalid')
})
