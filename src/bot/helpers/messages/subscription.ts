import type {Subscription, Chat} from '../../../lib/database/types.js'
import type {BotContext} from '../../context.js'
import {buildSubscriptionKeyboard} from '../keyboards/subscription.js'

type SubscriptionWithChat = Subscription & {chat: Chat}

export async function editMessageWithSubscription(
  ctx: BotContext,
  subscription: SubscriptionWithChat,
) {
  await ctx.editMessageText(buildText(ctx.t, subscription), {
    reply_markup: buildSubscriptionKeyboard(ctx.t, subscription),
  })
}

function buildText(t: BotContext['t'], subscription: SubscriptionWithChat) {
  return t('subscription', {
    chatTitle: subscription.chat.title,
    price: subscription.price,
    endsAt: subscription.endsAt ?? 'no',
    autoRenew: subscription.autoRenew ? 'yes' : 'no',
  })
}
