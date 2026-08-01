import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getAccessibleChat, updateChat} from '../../../models/chat.js'
import {editMessageWithChat} from '../../helpers/messages/chat.js'

export const removeCustomMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  let chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  chat = await updateChat(id, {
    customMessageRu: null,
    customMessageEn: null,
  })

  return editMessageWithChat(ctx, chat)
}

function parseMatch(match: string | RegExpMatchArray): {id: number} {
  const strId = typeof match === 'string' ? undefined : match[1]
  if (strId === undefined) throw new Error('Invalid callback match')
  return {id: parseInt(strId, 10)}
}
