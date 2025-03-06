import {CallbackQueryContext} from 'grammy'
import {BotContext} from '../../context.js'
import {getSubscriptionById} from '../../../models/subscriptions.js'
import {editMessageWithSubscription} from '../../helpers/messages/subscription.js'

export const subscriptionCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const subscription = await getSubscriptionById(id)
  if (!subscription) return ctx.editMessageText(ctx.t('subscription.not-found'))

  return editMessageWithSubscription(ctx, subscription)
}

function parseMatch(match: string | RegExpMatchArray) {
  const [, id] = match
  return {id: id!}
}
