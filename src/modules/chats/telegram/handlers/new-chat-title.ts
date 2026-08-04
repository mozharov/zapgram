import {getChat, updateChat} from '@modules/chats/repository.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import type {BaseContext} from '@telegram/context.js'
import type {ChatTypeContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

type Context = ChatTypeContext<BaseContext, 'supergroup' | 'channel'>

export const newChatTitleHandler = async (ctx: Context) => {
  ctx.log.info({title: ctx.chat.title, chatId: ctx.chatId}, 'new chat title')
  const chat = await getChat({id: ctx.chatId})
  if (!chat) return
  const updated = await updateChat(chat.id, {title: ctx.chat.title})
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, updated, String(updated.ownerId))
  captureBotEvent(
    posthog,
    'chat_title_updated',
    {chat_title: updated.title, chat_type: updated.type},
    {chatId: updated.id, distinctId: String(updated.ownerId)},
  )
}
