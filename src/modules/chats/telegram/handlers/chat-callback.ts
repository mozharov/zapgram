import {getAccessibleChat} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {chatRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const chatCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId} = chatRoute.parse(ctx.match)
  const chat = await getAccessibleChat(chatId)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  return editMessageWithChat(ctx, chat)
}
