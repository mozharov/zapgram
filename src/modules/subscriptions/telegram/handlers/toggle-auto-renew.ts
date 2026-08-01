import {getSubscriptionById, updateSubscription} from '@modules/subscriptions/repository.js'
import {editMessageWithSubscription} from '@modules/subscriptions/telegram/messages/subscription.js'
import {subscriptionRenewRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const toggleAutoRenewCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {subscriptionId: id} = subscriptionRenewRoute.parse(ctx.match)

  const subscription = await getSubscriptionById(id)
  if (!subscription) return ctx.editMessageText(ctx.t('subscription.not-found'))

  await updateSubscription(id, {autoRenew: !subscription.autoRenew})
  subscription.autoRenew = !subscription.autoRenew

  return editMessageWithSubscription(ctx, subscription)
}
