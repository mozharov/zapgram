import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {editMessageWithCustomMessage} from '@modules/chats/telegram/messages/custom-message.js'
import {chatCustomMessageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const customMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id} = chatCustomMessageRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(id, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  return editMessageWithCustomMessage(ctx, chat)
}
