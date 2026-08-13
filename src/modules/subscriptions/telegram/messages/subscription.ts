import type {Chat, Subscription} from '@infra/db/types.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {buildSubscriptionKeyboard} from '../keyboards/subscription.js'

type SubscriptionWithChat = Subscription & {chat: Chat}

export async function editMessageWithSubscription(
  ctx: BotContext,
  subscription: SubscriptionWithChat,
) {
  await ctx.editMessageText(await buildText(ctx.t, subscription), {
    reply_markup: buildSubscriptionKeyboard(ctx.t, subscription),
  })
}

async function buildText(t: BotContext['t'], subscription: SubscriptionWithChat) {
  return t('subscription', {
    chatTitle: subscription.chat.title,
    price: subscription.price,
    endsAt: subscription.endsAt ?? 'no',
    autoRenew: subscription.autoRenew ? 'yes' : 'no',
    usdSuffix: await usdSuffixForSats(subscription.price),
  })
}
