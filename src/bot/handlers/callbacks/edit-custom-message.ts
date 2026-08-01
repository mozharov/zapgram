import {getAccessibleChat} from '@modules/chats/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {editCustomMessage} from '../../conversations/edit-custom-message.js'

export const editCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const chat = await getAccessibleChat(id)

  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  await ctx.deleteMessage()
  return ctx.conversation.enter(editCustomMessage.name, {chatId: id})
}

function parseMatch(match: string | RegExpMatchArray): {id: number} {
  const strId = typeof match === 'string' ? undefined : match[1]
  if (strId === undefined) throw new Error('Invalid callback match')
  return {id: parseInt(strId, 10)}
}
