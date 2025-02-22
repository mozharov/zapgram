import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'
import type {Chat} from '../../../lib/database/types.js'
import {bot} from '../../bot.js'

export function buildChatsKeyboard(
  t: BotContext['t'],
  chats: Chat[],
  page: number,
  hasNext: boolean,
) {
  const keyboard = new InlineKeyboard()
  for (const chat of chats) {
    keyboard.row({
      callback_data: `chat:${chat.id}`,
      text: chat.title,
    })
  }
  keyboard.row()
  if (page > 1) {
    keyboard.add({
      callback_data: `chats:${page - 1}`,
      text: t('button.prev'),
    })
  }
  if (hasNext) {
    keyboard.add({
      callback_data: `chats:${page + 1}`,
      text: t('button.next'),
    })
  }
  return keyboard.row({
    url: `https://t.me/${bot.botInfo.username}?startgroup=true`,
    text: t('button.add-chat'),
  })
}
