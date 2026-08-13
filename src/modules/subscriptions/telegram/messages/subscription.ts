import type {Chat, Subscription} from '@infra/db/types.js'
import type {BotContext} from '@telegram/context.js'
import {editLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {buildSubscriptionKeyboard} from '../keyboards/subscription.js'

type SubscriptionWithChat = Subscription & {chat: Chat}

export async function editMessageWithSubscription(
  ctx: BotContext,
  subscription: SubscriptionWithChat,
) {
  const text = await buildText(ctx.t, subscription)
  await editLivingMenu(ctx, () =>
    ctx.editMessageText(text, {reply_markup: buildSubscriptionKeyboard(ctx.t, subscription)}),
  )
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
