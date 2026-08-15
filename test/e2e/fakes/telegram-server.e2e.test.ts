import {afterEach, describe, expect, test} from 'bun:test'
import {createBot} from '@infra/telegram/bot.js'
import {GrammyError, InputFile} from 'grammy'
import type {UserFromGetMe} from 'grammy/types'
import {type FakeTelegram, startFakeTelegram} from './telegram-server.js'

const token = '000000:test-token'
const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'ZapGram',
  username: 'zap_gram_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

let fake: FakeTelegram | undefined

afterEach(() => {
  fake?.stop()
  fake = undefined
})

describe('fake Telegram Bot API server', () => {
  test('captures the HTML parse mode added by the real createBot transformer', async () => {
    const {bot, tg} = await setup()

    await bot.api.sendMessage(1, '<b>hi</b>')

    expect(tg.last('sendMessage')).toEqual({chat_id: 1, text: '<b>hi</b>', parse_mode: 'HTML'})
  })

  test('captures multipart InputFile fields and parses nested JSON', async () => {
    const {bot, tg} = await setup()

    await bot.api.sendPhoto(777, new InputFile(new TextEncoder().encode('photo')), {
      reply_markup: {inline_keyboard: [[{text: 'OK', callback_data: 'ok'}]]},
    })

    const payload = tg.last('sendPhoto')
    expect(payload?.chat_id).toBe('777')
    expect(payload?.parse_mode).toBe('HTML')
    expect(payload?.reply_markup).toEqual({
      inline_keyboard: [[{text: 'OK', callback_data: 'ok'}]],
    })
    expect(payload?.photo).toStartWith('attach://')

    const attachmentKey = String(payload?.photo).slice('attach://'.length)
    const attachment = payload?.[attachmentKey]
    expect(attachment).toBeInstanceOf(File)
    if (!(attachment instanceof File)) throw new Error('Multipart attachment was not a File')
    expect(attachment.name).toBe('photo.jpg')
    expect(await attachment.text()).toBe('photo')
  })

  test('captures a rich message with its inline keyboard', async () => {
    const {bot, tg} = await setup()

    const sent = await bot.api.sendRichMessage(
      777,
      {html: '<h1>ZapGram</h1><p>Wallet</p>'},
      {reply_markup: {inline_keyboard: [[{text: 'Open', callback_data: 'wallet'}]]}},
    )

    expect(tg.last('sendRichMessage')).toEqual({
      chat_id: 777,
      rich_message: {html: '<h1>ZapGram</h1><p>Wallet</p>'},
      reply_markup: {inline_keyboard: [[{text: 'Open', callback_data: 'wallet'}]]},
    })
    expect(tg.lastMessageId('sendRichMessage')).toBe(sent.message_id)
  })

  test('records message results and preserves message ids across edits', async () => {
    const {bot, tg} = await setup()

    const prompt = await bot.api.sendMessage(777, 'Prompt')
    expect(tg.lastResult('sendMessage')).toMatchObject({message_id: prompt.message_id})
    expect(tg.lastMessageId('sendMessage')).toBe(prompt.message_id)

    const editedText = await bot.api.editMessageText(777, prompt.message_id, 'Updated prompt')
    expect(editedText).not.toBe(true)
    expect(tg.lastMessageId('editMessageText')).toBe(prompt.message_id)

    const photo = await bot.api.sendPhoto(777, 'photo-file-id', {caption: 'Before'})
    const editedCaption = await bot.api.editMessageCaption(777, photo.message_id, {
      caption: 'After',
    })
    expect(editedCaption).not.toBe(true)
    expect(tg.lastMessageId('editMessageCaption')).toBe(photo.message_id)

    tg.reset()
    expect(tg.lastResult('sendMessage')).toBeUndefined()
    expect(tg.lastMessageId('sendPhoto')).toBeUndefined()
  })

  test('retries a Bot API 429 immediately when retry_after is zero', async () => {
    const {bot, tg} = await setup()
    tg.fail('sendMessage', {error_code: 429, description: 'Too Many Requests', retry_after: 0})
    const startedAt = performance.now()

    await bot.api.sendMessage(1, 'retry me')

    expect(tg.of('sendMessage')).toHaveLength(2)
    expect(performance.now() - startedAt).toBeLessThan(100)
  })

  test('does not retry a 429 without retry_after and exposes GrammyError', async () => {
    const {bot, tg} = await setup()
    tg.fail('sendMessage', {error_code: 429, description: 'Too Many Requests'})

    await expect(bot.api.sendMessage(1, 'do not retry')).rejects.toBeInstanceOf(GrammyError)

    expect(tg.of('sendMessage')).toHaveLength(1)
  })

  test('bot.init calls getMe and receives the default bot identity', async () => {
    fake = await startFakeTelegram()
    const bot = createBot(token, undefined, {apiRoot: fake.url})

    await bot.init()

    expect(fake.of('getMe')).toHaveLength(1)
    expect(bot.botInfo.username).toBe('zap_gram_bot')
  })

  test('allows the administrator list to be overridden for one call', async () => {
    const {bot, tg} = await setup()
    const admins = [
      {
        status: 'creator' as const,
        user: {id: 42, is_bot: false, first_name: 'Different Owner'},
        is_anonymous: false,
      },
    ]
    tg.reply('getChatAdministrators', admins)

    expect(await bot.api.getChatAdministrators(-1001)).toEqual(admins)
    expect((await bot.api.getChatAdministrators(-1001))[0]?.user.id).toBe(777)
  })

  test('silently answers an already scheduled request after stop without recording it', async () => {
    fake = await startFakeTelegram()
    const url = `${fake.url}/bot${token}/deleteMessages`
    const lateRequest = new Promise<Response>((resolve, reject) => {
      setTimeout(() => {
        fetch(url, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({chat_id: 777, message_ids: [1]}),
        }).then(resolve, reject)
      }, 5)
    })

    fake.stop()
    const response = await lateRequest

    expect(await response.json()).toEqual({ok: true, result: true})
    expect(fake.calls).toEqual([])
  })
})

async function setup() {
  fake = await startFakeTelegram()
  return {tg: fake, bot: createBot(token, botInfo, {apiRoot: fake.url})}
}
