import {
  getUserActiveSubscriptions,
  getUserActiveSubscriptionsCount,
} from '@modules/subscriptions/repository.js'
import {buildSubscriptionsKeyboard} from '@modules/subscriptions/telegram/keyboards/subscriptions.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export const subscriptionsCommand = async (ctx: BotContext) => {
  const limit = getRuntime().config.chatsPerPage
  const totalSubscriptions = await getUserActiveSubscriptionsCount(ctx.user.id)

  if (totalSubscriptions === 0) return ctx.reply(ctx.t('subscriptions.empty'))

  const subscriptions = await getUserActiveSubscriptions(ctx.user.id, 1, limit)
  return ctx.reply(ctx.t('subscriptions'), {
    reply_markup: buildSubscriptionsKeyboard(ctx.t, subscriptions, 1, totalSubscriptions > limit),
  })
}
