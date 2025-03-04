import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'
import type {Subscription, Chat} from '../../../lib/database/types.js'

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
      callback_data: `subscription:${subscription.id}`,
      text: subscription.chat.title,
    })
  }
  keyboard.row()
  if (page > 1) {
    keyboard.add({
      callback_data: `subscriptions:${page - 1}`,
      text: t('button.prev'),
    })
  }
  if (hasNext) {
    keyboard.add({
      callback_data: `subscriptions:${page + 1}`,
      text: t('button.next'),
    })
  }
  return keyboard
}
