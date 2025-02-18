import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'

export function buildSendMenuKeyboard(t: BotContext['t']) {
  const keyboard = new InlineKeyboard()
    .row({
      callback_data: 'pay-invoice',
      text: t('button.pay-invoice'),
    })
    .row({
      callback_data: 'send-to-user',
      text: t('button.send-to-user'),
    })
    .row({
      callback_data: 'wallet',
      text: t('button.back'),
    })
  return keyboard
}
