import {CallbackQueryContext} from 'grammy'
import {BotContext} from '../../context.js'
import {getAccessibleChat, updateChat} from '../../../models/chat.js'
import {editMessageWithChat} from '../../helpers/messages/chat.js'

export const turnPaidAccessCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id, status} = parseMatch(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChat(id, {status})
  return editMessageWithChat(ctx, chat)
}

function parseMatch(match: string | RegExpMatchArray): {id: number; status: 'active' | 'inactive'} {
  const [, strId, action] = match
  const id = parseInt(strId!)
  if (action !== 'on' && action !== 'off') throw new Error('Invalid action')
  return {id, status: action === 'on' ? 'active' : 'inactive'}
}
