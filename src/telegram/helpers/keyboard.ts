import {bot} from '@infra/telegram/bot.js'
import type {Message} from 'grammy/types'

export async function removeInlineKeyboard(message: Message) {
  await bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
    reply_markup: {inline_keyboard: []},
  })
}
