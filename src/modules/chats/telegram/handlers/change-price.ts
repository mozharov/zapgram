import {getAccessibleChat} from '@modules/chats/repository.js'
import {chatChangePriceRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {changingPrice} from '../conversations/changing-price.js'

export const changePriceCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId} = chatChangePriceRoute.parse(ctx.match)
  const chat = await getAccessibleChat(chatId)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  await ctx.deleteMessage()
  return ctx.conversation.enter(changingPrice.name, chat.id)
}
