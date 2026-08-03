import {getSubscriptionById} from '@modules/subscriptions/repository.js'
import {editMessageWithSubscription} from '@modules/subscriptions/telegram/messages/subscription.js'
import {subscriptionRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'

export const subscriptionCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {subscriptionId: id} = subscriptionRoute.parse(ctx.match)
  const subscription = await getSubscriptionById(id)
  if (!subscription) return ctx.editMessageText(ctx.t('subscription.not-found'))

  return editMessageWithSubscription(ctx, subscription)
}
