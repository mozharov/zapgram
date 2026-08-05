import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {chatChangePriceRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import type {CallbackQueryContext} from 'grammy'
import {changingPrice} from '../conversations/changing-price.js'

export const changePriceCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId} = chatChangePriceRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  await deleteMessageSafely(ctx)
  return ctx.conversation.enter(changingPrice.name, chat.id)
}
