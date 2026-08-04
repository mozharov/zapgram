import {describe, expect, test} from 'bun:test'
import type {Context} from 'grammy'
import {
  buildUpdateProperties,
  isBotRelevantUpdate,
  landingStartPayload,
  mergePersonProperties,
  parseLandingStartPayload,
  personPropertiesFromDb,
  personPropertiesFromTelegram,
} from './analytics.js'

function ctx(partial: Record<string, unknown>): Context {
  return {
    me: {id: 1, is_bot: true, first_name: 'ZapGram', username: 'zap_gram_bot'},
    ...partial,
  } as unknown as Context
}

describe('isBotRelevantUpdate', () => {
  test('tracks private messages from humans', () => {
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: 42, type: 'private'},
        }),
      ),
    ).toBe(true)
  })

  test('ignores bot actors', () => {
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 1, is_bot: true, first_name: 'Bot'},
          chat: {id: 42, type: 'private'},
        }),
      ),
    ).toBe(false)
  })

  test('ignores unrelated group chatter', () => {
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: 'hello everyone'},
        }),
      ),
    ).toBe(false)
  })

  test('tracks tip commands and bot mentions in groups', () => {
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/tip 21'},
        }),
      ),
    ).toBe(true)

    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: 'hey @zap_gram_bot'},
        }),
      ),
    ).toBe(true)
  })

  test('tracks my_chat_member and join requests', () => {
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          myChatMember: {
            old_chat_member: {status: 'left'},
            new_chat_member: {status: 'administrator'},
          },
        }),
      ),
    ).toBe(true)

    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          chatJoinRequest: {},
        }),
      ),
    ).toBe(true)
  })
})

describe('buildUpdateProperties', () => {
  test('extracts command and chat metadata', () => {
    const props = buildUpdateProperties(
      ctx({
        update: {update_id: 1, message: {}},
        from: {id: 42, is_bot: false, first_name: 'A', username: 'alice', language_code: 'ru'},
        chat: {id: -100, type: 'supergroup', title: 'Paid', username: 'paidchat'},
        message: {text: '/tip@zap_gram_bot 21'},
      }),
    )

    expect(props).toMatchObject({
      update_type: 'message',
      chat_type: 'supergroup',
      chat_id: -100,
      chat_title: 'Paid',
      command: 'tip',
      from_username: 'alice',
      from_language_code: 'ru',
    })
  })
})

describe('mergePersonProperties', () => {
  test('Telegram profile fields override DB when merged db-then-telegram', () => {
    const merged = mergePersonProperties(
      personPropertiesFromDb({
        id: 42,
        username: 'stale',
        firstName: 'Old',
        languageCode: 'en',
        nwcTips: true,
        nwcUrl: 'nostr+walletconnect://x',
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
      personPropertiesFromTelegram({
        id: 42,
        is_bot: false,
        first_name: 'New',
        username: 'fresh',
        language_code: 'ru',
      }),
    )

    expect(merged.$set).toMatchObject({
      username: 'fresh',
      first_name: 'New',
      language_code: 'ru',
      nwc_connected: true,
      nwc_tips_enabled: true,
    })
  })
})

describe('landingStartPayload / parseLandingStartPayload', () => {
  test('encodes web distinct_id for Telegram deep links', () => {
    expect(landingStartPayload('019fcc22-9bf6-7940-a625-47fcc057c855')).toBe(
      'lp_019fcc22-9bf6-7940-a625-47fcc057c855',
    )
  })

  test('strips illegal Telegram payload characters', () => {
    expect(landingStartPayload('user@example.com')).toBe('lp_userexamplecom')
  })

  test('falls back to bare landing when id is empty after sanitize', () => {
    expect(landingStartPayload('@@@')).toBe('landing')
  })

  test('parses lp_ payload for identity merge', () => {
    expect(parseLandingStartPayload('lp_abc-123')).toEqual({
      fromLanding: true,
      landingDistinctId: 'abc-123',
    })
  })

  test('parses bare landing without distinct_id', () => {
    expect(parseLandingStartPayload('landing')).toEqual({fromLanding: true})
  })

  test('ignores unrelated start params', () => {
    expect(parseLandingStartPayload('invite_xyz')).toEqual({fromLanding: false})
    expect(parseLandingStartPayload(undefined)).toEqual({fromLanding: false})
  })
})
