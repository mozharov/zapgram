import {describe, expect, test} from 'bun:test'
import type {Context} from 'grammy'
import {
  buildUpdateProperties,
  isBotRelevantUpdate,
  isHandledGroupSlashCommand,
  landingStartPayload,
  mergePersonProperties,
  parseLandingStartPayload,
  personPropertiesFromDb,
  personPropertiesFromTelegram,
  resolveCallbackEventName,
  resolveUpdateEventName,
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
          message: {text: '/tip@zap_gram_bot 21'},
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

  test('ignores group commands the bot does not handle', () => {
    // Private-only bot commands that privacy mode still delivers in groups.
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/wallet'},
        }),
      ),
    ).toBe(false)

    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/start'},
        }),
      ),
    ).toBe(false)

    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/settings@zap_gram_bot'},
        }),
      ),
    ).toBe(false)

    // Other bots' commands, even when the name matches a handled command.
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/tip@some_other_bot 21'},
        }),
      ),
    ).toBe(false)

    // Unrelated slash commands from other bots / admins.
    expect(
      isBotRelevantUpdate(
        ctx({
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          message: {text: '/ban 123'},
        }),
      ),
    ).toBe(false)
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

describe('isHandledGroupSlashCommand', () => {
  test('accepts tip for this bot or unscoped', () => {
    expect(isHandledGroupSlashCommand('/tip 21', 'zap_gram_bot')).toBe(true)
    expect(isHandledGroupSlashCommand('/tip@zap_gram_bot', 'zap_gram_bot')).toBe(true)
    expect(isHandledGroupSlashCommand('/TIP@Zap_Gram_Bot 5 @alice', 'zap_gram_bot')).toBe(true)
  })

  test('rejects private-only commands and other bots', () => {
    expect(isHandledGroupSlashCommand('/wallet', 'zap_gram_bot')).toBe(false)
    expect(isHandledGroupSlashCommand('/tip@other_bot', 'zap_gram_bot')).toBe(false)
    expect(isHandledGroupSlashCommand('/tip@other_bot', undefined)).toBe(false)
    expect(isHandledGroupSlashCommand('hello', 'zap_gram_bot')).toBe(false)
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

describe('resolveCallbackEventName', () => {
  test('maps static callbacks', () => {
    expect(resolveCallbackEventName('pay-invoice')).toBe('callback_pay_invoice')
    expect(resolveCallbackEventName('create-invoice')).toBe('callback_create_invoice')
    expect(resolveCallbackEventName('wallet')).toBe('callback_wallet')
    expect(resolveCallbackEventName('connect-nwc')).toBe('callback_connect_nwc')
  })

  test('maps parameterized routes by route name', () => {
    expect(resolveCallbackEventName('pay-sub:abc-def:wallet')).toBe('callback_pay_subscription')
    expect(resolveCallbackEventName('chat:-100:on-paid')).toBe('callback_chat_paid_access')
    expect(resolveCallbackEventName('chat:-100:turn-monthly')).toBe('callback_chat_payment_type')
    expect(
      resolveCallbackEventName('subscription:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:renew'),
    ).toBe('callback_subscription_renew')
    expect(resolveCallbackEventName('chats:2')).toBe('callback_chats_page')
  })

  test('falls back to first segment for unknown data', () => {
    expect(resolveCallbackEventName('future-feature:1')).toBe('callback_future_feature')
  })
})

describe('resolveUpdateEventName', () => {
  test('names slash commands', () => {
    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, message: {}},
          message: {text: '/start lp_abc'},
        }),
      ),
    ).toBe('command_start')

    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, message: {}},
          message: {text: '/tip@zap_gram_bot 21'},
        }),
      ),
    ).toBe('command_tip')
  })

  test('names callback queries', () => {
    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, callback_query: {}},
          callbackQuery: {data: 'pay-invoice'},
        }),
      ),
    ).toBe('callback_pay_invoice')
  })

  test('names ln invoice paste and system updates', () => {
    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, message: {}},
          message: {text: 'lnbc1p0xxxxxxxx'},
        }),
      ),
    ).toBe('ln_invoice_pasted')

    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, chat_join_request: {}},
          chatJoinRequest: {},
        }),
      ),
    ).toBe('chat_join_request')

    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, my_chat_member: {}},
          myChatMember: {
            old_chat_member: {status: 'left'},
            new_chat_member: {status: 'administrator'},
          },
        }),
      ),
    ).toBe('my_chat_member')
  })

  test('falls back for plain messages', () => {
    expect(
      resolveUpdateEventName(
        ctx({
          update: {update_id: 1, message: {}},
          message: {text: 'hello'},
        }),
      ),
    ).toBe('telegram_message')
  })
})

describe('personPropertiesFromTelegram', () => {
  test('sets name and $name for stable PostHog person display', () => {
    const patch = personPropertiesFromTelegram({
      id: 4242424242,
      is_bot: false,
      first_name: 'Avery',
      last_name: 'Quillworth',
      username: 'avery_quillworth',
    })

    expect(patch.$set).toMatchObject({
      name: 'Avery Quillworth',
      $name: 'Avery Quillworth',
      telegram_id: 4242424242,
      username: 'avery_quillworth',
    })
  })

  test('falls back to username then id when names are empty', () => {
    expect(
      personPropertiesFromTelegram({
        id: 1,
        is_bot: false,
        first_name: '',
        username: 'only_user',
      }).$set?.name,
    ).toBe('only_user')

    expect(
      personPropertiesFromTelegram({
        id: 99,
        is_bot: false,
        first_name: '',
      }).$set?.name,
    ).toBe('99')
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
        donationPercent: 0,
        donationScope: 'all',
        monthlyDonationSats: 0,
        monthlyDonationNextAt: null,
        monthlyDonationLastHash: null,
        monthlyDonationLastFailNotifyAt: null,
        botBlocked: false,
        lastMenuMessageId: null,
        lastNotificationMessageId: null,
        lastNotificationBaseMarkup: null,
        lastNotificationTransient: false,
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
      name: 'New',
      $name: 'New',
      username: 'fresh',
      first_name: 'New',
      language_code: 'ru',
      nwc_connected: true,
      nwc_tips_enabled: true,
    })
  })

  test('local $set patches keep Telegram display name when merged after', () => {
    const merged = mergePersonProperties(
      personPropertiesFromTelegram({
        id: 42,
        is_bot: false,
        first_name: 'Avery',
        last_name: 'Quillworth',
      }),
      {$set: {nwc_connected: false, nwc_tips_enabled: false}},
    )

    expect(merged.$set).toMatchObject({
      name: 'Avery Quillworth',
      $name: 'Avery Quillworth',
      nwc_connected: false,
      nwc_tips_enabled: false,
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
