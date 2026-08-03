import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {chatPaidAccessRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const turnPaidAccessCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id, status} = chatPaidAccessRoute.parse(ctx.match)
  let chat = await getAccessibleChatForOwner(id, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {status})
  return editMessageWithChat(ctx, chat)
}
