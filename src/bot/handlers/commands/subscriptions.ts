import {config} from '../../../config.js'
import {
  getUserActiveSubscriptions,
  getUserActiveSubscriptionsCount,
} from '../../../models/subscriptions.js'
import type {BotContext} from '../../context.js'
import {buildSubscriptionsKeyboard} from '../../helpers/keyboards/subscriptions.js'

export const subscriptionsCommand = async (ctx: BotContext) => {
  const limit = config.chatsPerPage
  const totalSubscriptions = await getUserActiveSubscriptionsCount(ctx.user.id)

  if (totalSubscriptions === 0) return ctx.reply(ctx.t('subscriptions.empty'))

  const subscriptions = await getUserActiveSubscriptions(ctx.user.id, 1, limit)
  return ctx.reply(ctx.t('subscriptions'), {
    reply_markup: buildSubscriptionsKeyboard(ctx.t, subscriptions, 1, totalSubscriptions > limit),
  })
}
