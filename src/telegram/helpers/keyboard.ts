import type {Message} from 'grammy/types'
import {getRuntime} from '../../runtime.js'

export async function removeInlineKeyboard(message: Message) {
  await getRuntime().bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
    reply_markup: {inline_keyboard: []},
  })
}
