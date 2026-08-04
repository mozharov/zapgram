import {getSubscriptionById, updateSubscription} from '@modules/subscriptions/repository.js'
import {editMessageWithSubscription} from '@modules/subscriptions/telegram/messages/subscription.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {subscriptionRenewRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const toggleAutoRenewCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {subscriptionId: id} = subscriptionRenewRoute.parse(ctx.match)

  const subscription = await getSubscriptionById(id)
  if (!subscription) return ctx.editMessageText(ctx.t('subscription.not-found'))

  await updateSubscription(id, {autoRenew: !subscription.autoRenew})
  subscription.autoRenew = !subscription.autoRenew

  captureBotEvent(
    getRuntime().posthog,
    'subscription_auto_renew_toggled',
    {
      auto_renew_enabled: subscription.autoRenew,
      chat_id: subscription.chatId,
      subscription_id: subscription.id,
      price_sats: subscription.price,
    },
    {chatId: subscription.chatId},
  )

  return editMessageWithSubscription(ctx, subscription)
}
