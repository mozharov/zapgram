import {getAccessibleChat, updateChat} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {chatPaymentTypeRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const turnPaymentTypeCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id, paymentType} = chatPaymentTypeRoute.parse(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {paymentType})
  return editMessageWithChat(ctx, chat)
}
