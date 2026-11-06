import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
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
      textKind: 'other',
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

  test('never carries message text or a hash of it — only length and kind', () => {
    const secret = 'nostr+walletconnect://deadbeef?secret=supersecret'
    const invoice = '  Lightning:LNBC1PUNIQUEBODYZZ  '
    const description = describeUpdate(
      ctx({
        update: {update_id: 9, message: {}},
        from: {id: 42, is_bot: false, first_name: 'A'},
        chat: {id: 42, type: 'private'},
        message: {text: secret},
      }),
    )
    const invoiceLog = describeUpdate(
      ctx({
        update: {update_id: 11, message: {}},
        from: {id: 42, is_bot: false, first_name: 'A'},
        chat: {id: 42, type: 'private'},
        message: {text: invoice},
      }),
    )

    const secretJson = JSON.stringify(description)
    const secretDigest = createHash('sha256').update(secret).digest('hex')
    expect(secretJson).not.toContain('secret')
    expect(secretJson).not.toContain('deadbeef')
    expect(secretJson).not.toContain(secretDigest)
    expect(secretJson).not.toContain(secretDigest.slice(0, 16))
    expect(description.textLength).toBe(secret.length)
    expect(description.textKind).toBe('other')
    expect(description.command).toBeUndefined()

    const invoiceJson = JSON.stringify(invoiceLog)
    const invoiceDigest = createHash('sha256').update(invoice).digest('hex')
    const normalized = 'lnbc1puniquebodyzz'
    expect(invoiceLog.textKind).toBe('bolt11_invoice')
    expect(invoiceJson).not.toContain(normalized)
    expect(invoiceJson).not.toContain('LNBC1PUNIQUEBODYZZ')
    expect(invoiceJson).not.toContain(invoiceDigest)
    expect(invoiceJson).not.toContain(createHash('sha256').update(normalized).digest('hex'))
    expect(invoiceJson).not.toContain(
      createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    )
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
