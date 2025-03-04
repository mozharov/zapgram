import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'
import type {Subscription, Chat} from '../../../lib/database/types.js'

type SubscriptionWithChat = Subscription & {chat: Chat}

export function buildSubscriptionKeyboard(t: BotContext['t'], subscription: SubscriptionWithChat) {
  const keyboard = new InlineKeyboard()

  if (subscription.autoRenew) {
    keyboard.row({
      callback_data: `subscription:${subscription.id}:turn-auto-renew`,
      text: t('button.disable-auto-renew'),
    })
  } else {
    keyboard.row({
      callback_data: `subscription:${subscription.id}:turn-auto-renew`,
      text: t('button.enable-auto-renew'),
    })
  }

  return keyboard.row({
    callback_data: 'subscriptions:1',
    text: t('button.back'),
  })
}
