import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {editMessageWithChat} from '@modules/chats/telegram/messages/chat.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {chatOnchainDisableRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const disableOnchainCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId} = chatOnchainDisableRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  const {onchainEnableService, posthog} = getRuntime()
  const result = await onchainEnableService.disable(chat, {deleteWallet: false})
  captureBotEvent(posthog, 'chat_onchain_disabled', {chat_title: result.chat.title}, {chatId})
  await ctx.answerCallbackQuery()
  return editMessageWithChat(ctx, result.chat)
}
