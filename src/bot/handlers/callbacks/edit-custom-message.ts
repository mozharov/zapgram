import {CallbackQueryContext} from 'grammy'
import type {BotContext} from '../../context.js'
import {getAccessibleChat} from '../../../models/chat.js'
import {editCustomMessage} from '../../conversations/edit-custom-message.js'

export const editCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const chat = await getAccessibleChat(id)

  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  await ctx.deleteMessage()
  return ctx.conversation.enter(editCustomMessage.name, {chatId: id})
}

function parseMatch(match: string | RegExpMatchArray): {id: number} {
  const [, strId] = match
  const id = parseInt(strId!)
  return {id}
}
