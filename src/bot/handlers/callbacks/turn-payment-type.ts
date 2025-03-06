import {CallbackQueryContext} from 'grammy'
import {BotContext} from '../../context.js'
import {getAccessibleChat, updateChat} from '../../../models/chat.js'
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
  const [, strId, paymentType] = match
  const id = parseInt(strId!)
  if (paymentType !== 'one_time' && paymentType !== 'monthly') {
    throw new Error('Invalid payment type')
  }
  return {id, paymentType}
}
