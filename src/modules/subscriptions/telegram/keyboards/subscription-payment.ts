import type {SubscriptionPayment} from '@infra/db/types.js'
import {payLightningRoute, payOnchainRoute, paySubscriptionRoute} from '@telegram/callback-data.js'
import {InlineKeyboard} from 'grammy'

export function buildSubscriptionPaymentKeyboard(
  t: (key: string) => string,
  {payNWC = false, payWallet = false, paymentId, onchainChatId}: Args,
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
  if (onchainChatId !== undefined) {
    keyboard.row({
      callback_data: payOnchainRoute.build({chatId: onchainChatId}),
      text: t('button.pay-onchain'),
    })
  }
  return keyboard
}

/** On-chain join invoice view: switch back to Lightning. */
export function buildOnchainPaymentKeyboard(t: (key: string) => string, chatId: number) {
  return new InlineKeyboard().row({
    callback_data: payLightningRoute.build({chatId}),
    text: t('button.pay-lightning'),
  })
}

interface Args {
  payNWC?: boolean
  payWallet?: boolean
  paymentId: SubscriptionPayment['id']
  /** When set, show on-chain pay button for this chat. */
  onchainChatId?: number
}
