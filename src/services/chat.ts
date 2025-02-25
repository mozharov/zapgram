import {bot} from '../bot/bot.js'
import type {Chat} from '../lib/database/types.js'
import {logger} from '../lib/logger.js'
import {getChat, updateChat} from '../models/chat.js'

export async function updateChatFromTelegram(chatId: Chat['id']) {
  const chat = await getChat({id: chatId})
  if (!chat) throw new Error(`Chat not found: ${chatId}`)
  const tgChat = await bot.api.getChat(chatId).catch((error: unknown) => {
    logger.error({error, chatId}, 'Error getting chat from Telegram')
    return null
  })

  if (tgChat) return updateChat(chatId, {title: tgChat.title!, username: tgChat.username})
  return chat
}
