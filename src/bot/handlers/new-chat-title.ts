import type {ChatTypeContext} from 'grammy'
import type {BaseContext} from '../context.js'
import {getChat, updateChat} from '../../models/chat.js'

type Context = ChatTypeContext<BaseContext, 'supergroup' | 'channel'>

export const newChatTitleHandler = async (ctx: Context) => {
  ctx.log.info({title: ctx.chat.title, chatId: ctx.chatId}, 'new chat title')
  const chat = await getChat({id: ctx.chatId})
  if (chat) await updateChat(chat.id, {title: ctx.chat.title})
}
