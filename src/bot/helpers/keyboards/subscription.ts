import type {Chat, Subscription} from '@infra/db/types.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

type SubscriptionWithChat = Subscription & {chat: Chat}

export function buildSubscriptionKeyboard(t: BotContext['t'], subscription: SubscriptionWithChat) {
  const keyboard = new InlineKeyboard()

  if (subscription.endsAt) {
    if (subscription.autoRenew) {
      keyboard.row({
        callback_data: `subscription:${subscription.id}:renew`,
        text: t('button.disable-auto-renew'),
      })
    } else {
      keyboard.row({
        callback_data: `subscription:${subscription.id}:renew`,
        text: t('button.enable-auto-renew'),
      })
    }
  }

  return keyboard.row({
    callback_data: 'subscriptions:1',
    text: t('button.back'),
  })
}
