import {getChat, updateChat} from '@modules/chats/repository.js'
import type {BaseContext} from '@telegram/context.js'
import type {ChatTypeContext} from 'grammy'

type Context = ChatTypeContext<BaseContext, 'supergroup' | 'channel'>

export const newChatTitleHandler = async (ctx: Context) => {
  ctx.log.info({title: ctx.chat.title, chatId: ctx.chatId}, 'new chat title')
  const chat = await getChat({id: ctx.chatId})
  if (chat) await updateChat(chat.id, {title: ctx.chat.title})
}
