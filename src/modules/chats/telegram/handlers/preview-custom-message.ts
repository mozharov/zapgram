import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {editMessageWithCustomMessagePreview} from '@modules/chats/telegram/messages/custom-message.js'
import {chatCustomMessagePreviewRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const previewCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId, locale} = chatCustomMessagePreviewRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  return editMessageWithCustomMessagePreview(ctx, chat, locale)
}
