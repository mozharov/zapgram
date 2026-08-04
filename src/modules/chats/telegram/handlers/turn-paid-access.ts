import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import {chatPaidAccessRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const turnPaidAccessCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id, status} = chatPaidAccessRoute.parse(ctx.match)
  let chat = await getAccessibleChatForOwner(id, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {status})
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, chat, String(ctx.user.id))
  captureBotEvent(
    posthog,
    'chat_paid_access_updated',
    {paid_access_status: status, chat_title: chat.title, payment_type: chat.paymentType},
    {chatId: id},
  )
  return editMessageWithChat(ctx, chat)
}
