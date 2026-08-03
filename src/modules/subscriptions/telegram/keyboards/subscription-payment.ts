import type {SubscriptionPayment} from '@infra/db/types.js'
import {paySubscriptionRoute} from '@telegram/callback-data.js'
import {InlineKeyboard} from 'grammy'

export function buildSubscriptionPaymentKeyboard(
  t: (key: string) => string,
  {payNWC = false, payWallet = false, paymentId}: Args,
) {
  const keyboard = new InlineKeyboard()
  if (payWallet) {
    keyboard.row({
      callback_data: paySubscriptionRoute.build({paymentId, from: 'wallet'}),
      text: t('button.pay-subcription-with-wallet'),
    })
  }
  if (payNWC) {
    keyboard.row({
      callback_data: paySubscriptionRoute.build({paymentId, from: 'nwc'}),
      text: t('button.pay-subcription-with-nwc'),
    })
  }
  return keyboard
}

interface Args {
  payNWC?: boolean
  payWallet?: boolean
  paymentId: SubscriptionPayment['id']
}
