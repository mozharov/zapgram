import {getAccessibleChat, updateChat} from '@modules/chats/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {editMessageWithChat} from '../../helpers/messages/chat.js'

export const turnPaymentTypeCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id, paymentType} = parseMatch(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {paymentType})
  return editMessageWithChat(ctx, chat)
}

function parseMatch(match: string | RegExpMatchArray): {
  id: number
  paymentType: 'one_time' | 'monthly'
} {
  if (typeof match === 'string') throw new Error('Invalid callback match')
  const strId = match[1]
  const paymentType = match[2]
  if (strId === undefined) throw new Error('Invalid callback match')
  if (paymentType !== 'one_time' && paymentType !== 'monthly') {
    throw new Error('Invalid payment type')
  }
  return {id: parseInt(strId, 10), paymentType}
}
