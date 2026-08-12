import {describe, expect, test} from 'bun:test'
import type {Context} from 'grammy'
import {describeUpdate} from './update-log.js'

function ctx(partial: Record<string, unknown>): Context {
  return {
    me: {id: 1, is_bot: true, first_name: 'ZapGram', username: 'zap_gram_bot'},
    ...partial,
  } as unknown as Context
}

describe('describeUpdate', () => {
  test('describes a private command by action, command, chat and user', () => {
    expect(
      describeUpdate(
        ctx({
          update: {update_id: 7, message: {}, reqId: 'abc12345'},
          from: {id: 42, is_bot: false, first_name: 'A', username: 'user_a'},
          chat: {id: 42, type: 'private'},
          message: {text: '/wallet'},
        }),
      ),
    ).toEqual({
      updateId: 7,
      updateType: 'message',
      action: 'command_wallet',
      chatId: 42,
      chatType: 'private',
      userId: 42,
      username: 'user_a',
      command: 'wallet',
      textLength: 7,
    })
  })

  test('describes a callback query by its route name and raw data', () => {
    const description = describeUpdate(
      ctx({
        update: {update_id: 8, callback_query: {}},
        from: {id: 42, is_bot: false, first_name: 'A'},
        chat: {id: 42, type: 'private'},
        callbackQuery: {data: 'pay-onchain:-100'},
      }),
    )

    expect(description.action).toBe('callback_pay_onchain')
    expect(description.callbackData).toBe('pay-onchain:-100')
    expect(description.updateType).toBe('callback_query')
    expect(description.username).toBeUndefined()
  })

  test('never carries message text — only its length', () => {
    const secret = 'nostr+walletconnect://deadbeef?secret=supersecret'
    const description = describeUpdate(
      ctx({
        update: {update_id: 9, message: {}},
        from: {id: 42, is_bot: false, first_name: 'A'},
        chat: {id: 42, type: 'private'},
        message: {text: secret},
      }),
    )

    expect(JSON.stringify(description)).not.toContain('secret')
    expect(description.textLength).toBe(secret.length)
    expect(description.command).toBeUndefined()
  })

  test('ignores the reqId the router stamps onto the update body', () => {
    // Without the guard, an update whose only other key is reqId would report `updateType: reqId`.
    expect(
      describeUpdate(
        ctx({
          update: {update_id: 10, reqId: 'abc12345', my_chat_member: {}},
          from: {id: 42, is_bot: false, first_name: 'A'},
          chat: {id: -100, type: 'supergroup', title: 'G'},
          myChatMember: {old_chat_member: {status: 'left'}, new_chat_member: {status: 'member'}},
        }),
      ),
    ).toMatchObject({updateType: 'my_chat_member', action: 'my_chat_member', chatId: -100})
  })
})
