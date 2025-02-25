import {CallbackQueryContext} from 'grammy'
import {BotContext} from '../../context.js'
import {getAccessibleChat} from '../../../models/chat.js'
import {editMessageWithChat} from '../../helpers/messages/chat.js'
import {updateChatFromTelegram} from '../../../services/chat.js'

export const chatCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  chat = await updateChatFromTelegram(chat.id)
  return editMessageWithChat(ctx, chat)
}

function parseMatch(match: string | RegExpMatchArray) {
  const [, strId] = match
  const id = parseInt(strId!)
  return {id}
}
