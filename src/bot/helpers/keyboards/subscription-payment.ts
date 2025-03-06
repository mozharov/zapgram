import {InlineKeyboard} from 'grammy'
import type {SubscriptionPayment} from '../../../lib/database/types.js'
import type {BotContext} from '../../context.js'

export function buildSubscriptionPaymentKeyboard(
  t: BotContext['t'],
  {payNWC = false, payWallet = false, paymentId}: Args,
) {
  const keyboard = new InlineKeyboard()
  if (payWallet) {
    keyboard.row({
      callback_data: `pay-sub:${paymentId}:wallet`,
      text: t('button.pay-subcription-with-wallet'),
    })
  }
  if (payNWC) {
    keyboard.row({
      callback_data: `pay-sub:${paymentId}:nwc`,
      text: t('button.pay-subcription-with-nwc'),
    })
  }
  return keyboard
}

interface Args {
  payNWC: boolean
  payWallet: boolean
  paymentId: SubscriptionPayment['id']
}
