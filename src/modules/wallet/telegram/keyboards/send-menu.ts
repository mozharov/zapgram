import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function buildSendMenuKeyboard(t: BotContext['t']) {
  const keyboard = new InlineKeyboard()
    .row({
      callback_data: staticCallback.payInvoice,
      text: t('button.pay-invoice'),
    })
    .row({
      callback_data: staticCallback.sendToUser,
      text: t('button.send-to-user'),
    })
    .row({
      callback_data: staticCallback.wallet,
      text: t('button.back'),
    })
  return keyboard
}
