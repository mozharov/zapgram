import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
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
  const strId = typeof match === 'string' ? undefined : match[1]
  if (strId === undefined) throw new Error('Invalid callback match')
  return {id: parseInt(strId, 10)}
}
