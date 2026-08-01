import type {Chat} from '@infra/db/types.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

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
  keyboard.row({
    callback_data: `chat:${chat.id}:custom-message`,
    text: t('button.custom-message'),
  })
  return keyboard.row({
    callback_data: 'chats:1',
    text: t('button.back'),
  })
}
