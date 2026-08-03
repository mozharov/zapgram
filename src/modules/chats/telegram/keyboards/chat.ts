import type {Chat} from '@infra/db/types.js'
import {
  chatChangePriceRoute,
  chatCustomMessageRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatsPageRoute,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function buildChatKeyboard(t: BotContext['t'], chat: Chat) {
  const keyboard = new InlineKeyboard()
  if (chat.status === 'active') {
    keyboard.row({
      callback_data: chatPaidAccessRoute.build({chatId: chat.id, status: 'inactive'}),
      text: t('button.disable-paid-access'),
    })
  } else {
    keyboard.row({
      callback_data: chatPaidAccessRoute.build({chatId: chat.id, status: 'active'}),
      text: t('button.enable-paid-access'),
    })
  }
  if (chat.paymentType === 'monthly') {
    keyboard.row({
      callback_data: chatPaymentTypeRoute.build({chatId: chat.id, paymentType: 'one_time'}),
      text: t('button.enable-one-time-payment'),
    })
  } else {
    keyboard.row({
      callback_data: chatPaymentTypeRoute.build({chatId: chat.id, paymentType: 'monthly'}),
      text: t('button.enable-monthly-payment'),
    })
  }
  keyboard.row({
    callback_data: chatChangePriceRoute.build({chatId: chat.id}),
    text: t('button.change-price'),
  })
  keyboard.row({
    callback_data: chatCustomMessageRoute.build({chatId: chat.id}),
    text: t('button.custom-message'),
  })
  return keyboard.row({
    callback_data: chatsPageRoute.build({page: 1}),
    text: t('button.back'),
  })
}
