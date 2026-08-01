import {getSubscriptionById} from '@modules/subscriptions/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {editMessageWithSubscription} from '../../helpers/messages/subscription.js'

export const subscriptionCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const subscription = await getSubscriptionById(id)
  if (!subscription) return ctx.editMessageText(ctx.t('subscription.not-found'))

  return editMessageWithSubscription(ctx, subscription)
}

function parseMatch(match: string | RegExpMatchArray) {
  const id = typeof match === 'string' ? undefined : match[1]
  if (id === undefined) throw new Error('Invalid callback match')
  return {id}
}
