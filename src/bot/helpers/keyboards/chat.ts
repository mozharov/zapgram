import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'
import type {Chat} from '../../../lib/database/types.js'

export function buildChatKeyboard(t: BotContext['t'], chat: Chat) {
  const keyboard = new InlineKeyboard()
  if (chat.status === 'active') {
    keyboard.row({
      callback_data: `chat:${chat.id}:off-paid`,
      text: t('button.disable-paid-access'),
    })
  } else {
    keyboard.row({
      callback_data: `chat:${chat.id}:on-paid`,
      text: t('button.enable-paid-access'),
    })
  }
  if (chat.paymentType === 'monthly') {
    keyboard.row({
      callback_data: `chat:${chat.id}:turn-one_time`,
      text: t('button.enable-one-time-payment'),
    })
  } else {
    keyboard.row({
      callback_data: `chat:${chat.id}:turn-monthly`,
      text: t('button.enable-monthly-payment'),
    })
  }
  keyboard.row({
    callback_data: `chat:${chat.id}:change-price`,
    text: t('button.change-price'),
  })
  return keyboard.row({
    callback_data: 'chats:1',
    text: t('button.back'),
  })
}
