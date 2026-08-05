import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {chatEditCustomMessageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import type {CallbackQueryContext} from 'grammy'
import {editCustomMessage} from '../conversations/edit-custom-message.js'

export const editCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id} = chatEditCustomMessageRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(id, ctx.user.id)

  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  await deleteMessageSafely(ctx)
  return ctx.conversation.enter(editCustomMessage.name, {chatId: id})
}
