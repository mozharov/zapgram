import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {editMessageWithCustomMessage} from '@modules/chats/telegram/messages/custom-message.js'
import {chatCustomMessageResetRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const resetCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId, locale} = chatCustomMessageResetRoute.parse(ctx.match)
  const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!owned) return ctx.editMessageText(ctx.t('chat.not-found'))

  const chat = await updateChat(
    chatId,
    locale === 'ru' ? {customMessageRu: null} : {customMessageEn: null},
  )
  return editMessageWithCustomMessage(ctx, chat)
}
