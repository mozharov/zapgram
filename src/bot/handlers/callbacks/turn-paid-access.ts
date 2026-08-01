import {getAccessibleChat, updateChat} from '@modules/chats/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {editMessageWithChat} from '../../helpers/messages/chat.js'

export const turnPaidAccessCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id, status} = parseMatch(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {status})
  return editMessageWithChat(ctx, chat)
}

function parseMatch(match: string | RegExpMatchArray): {id: number; status: 'active' | 'inactive'} {
  if (typeof match === 'string') throw new Error('Invalid callback match')
  const strId = match[1]
  const action = match[2]
  if (strId === undefined) throw new Error('Invalid callback match')
  if (action !== 'on' && action !== 'off') throw new Error('Invalid action')
  return {id: parseInt(strId, 10), status: action === 'on' ? 'active' : 'inactive'}
}
