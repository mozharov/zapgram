import type {Chat} from '@infra/db/types.js'
import {chatRoute, chatsPageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export function buildChatsKeyboard(
  t: BotContext['t'],
  chats: Chat[],
  page: number,
  hasNext: boolean,
) {
  const keyboard = new InlineKeyboard()
  for (const chat of chats) {
    keyboard.row({
      callback_data: chatRoute.build({chatId: chat.id}),
      text: chat.title,
    })
  }
  keyboard.row()
  if (page > 1) {
    keyboard.add({
      callback_data: chatsPageRoute.build({page: page - 1}),
      text: t('button.prev'),
    })
  }
  if (hasNext) {
    keyboard.add({
      callback_data: chatsPageRoute.build({page: page + 1}),
      text: t('button.next'),
    })
  }
  return keyboard.row({
    url: `https://t.me/${getRuntime().bot.botInfo.username}?startgroup=true`,
    text: t('button.add-chat'),
  })
}
