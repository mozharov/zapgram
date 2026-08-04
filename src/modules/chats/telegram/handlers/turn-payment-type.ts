import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import {chatPaymentTypeRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const turnPaymentTypeCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id, paymentType} = chatPaymentTypeRoute.parse(ctx.match)
  let chat = await getAccessibleChatForOwner(id, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {paymentType})
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, chat, String(ctx.user.id))
  captureBotEvent(
    posthog,
    'chat_payment_type_updated',
    {payment_type: paymentType, chat_title: chat.title, price_sats: chat.price},
    {chatId: id},
  )
  return editMessageWithChat(ctx, chat)
}
