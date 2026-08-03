import type {Chat, Subscription} from '@infra/db/types.js'
import {subscriptionRenewRoute, subscriptionsPageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

type SubscriptionWithChat = Subscription & {chat: Chat}

export function buildSubscriptionKeyboard(t: BotContext['t'], subscription: SubscriptionWithChat) {
  const keyboard = new InlineKeyboard()

  if (subscription.endsAt) {
    if (subscription.autoRenew) {
      keyboard.row({
        callback_data: subscriptionRenewRoute.build({subscriptionId: subscription.id}),
        text: t('button.disable-auto-renew'),
      })
    } else {
      keyboard.row({
        callback_data: subscriptionRenewRoute.build({subscriptionId: subscription.id}),
        text: t('button.enable-auto-renew'),
      })
    }
  }

  return keyboard.row({
    callback_data: subscriptionsPageRoute.build({page: 1}),
    text: t('button.back'),
  })
}
