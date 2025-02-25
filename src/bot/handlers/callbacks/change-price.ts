import type {CallbackQueryContext} from 'grammy'
import type {BotContext} from '../../context.js'
import {getAccessibleChat} from '../../../models/chat.js'
import {changingPrice} from '../../conversations/changing-price.js'

export const changePriceCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  await ctx.deleteMessage()
  return ctx.conversation.enter(changingPrice.name, chat.id)
}

function parseMatch(match: string | RegExpMatchArray): {id: number} {
  const [, strId] = match
  const id = parseInt(strId!)
  return {id}
}
