import type {Chat, Subscription} from '@infra/db/types.js'
import {staticCallback, subscriptionRoute, subscriptionsPageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

type SubscriptionWithChat = Subscription & {chat: Chat}

export function buildSubscriptionsKeyboard(
  t: BotContext['t'],
  subscriptions: SubscriptionWithChat[],
  page: number,
  hasNext: boolean,
) {
  const keyboard = new InlineKeyboard()
  for (const subscription of subscriptions) {
    keyboard.row({
      callback_data: subscriptionRoute.build({subscriptionId: subscription.id}),
      text: subscription.chat.title,
    })
  }
  keyboard.row()
  if (page > 1) {
    keyboard.add({
      callback_data: subscriptionsPageRoute.build({page: page - 1}),
      text: t('button.prev'),
    })
  }
  if (hasNext) {
    keyboard.add({
      callback_data: subscriptionsPageRoute.build({page: page + 1}),
      text: t('button.next'),
    })
  }
  return keyboard.row({
    callback_data: staticCallback.wallet,
    text: t('button.back'),
  })
}
