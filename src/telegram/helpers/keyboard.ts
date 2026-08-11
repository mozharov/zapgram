import type {Message} from 'grammy/types'
import {getRuntime} from '../../runtime.js'

export async function removeInlineKeyboardById(chatId: number, messageId: number) {
  await getRuntime().bot.api.editMessageReplyMarkup(chatId, messageId, {
    reply_markup: {inline_keyboard: []},
  })
}

export async function removeInlineKeyboard(message: Message) {
  await removeInlineKeyboardById(message.chat.id, message.message_id)
}
