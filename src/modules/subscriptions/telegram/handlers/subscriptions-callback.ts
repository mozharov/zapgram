import {
  getUserActiveSubscriptions,
  getUserActiveSubscriptionsCount,
} from '@modules/subscriptions/repository.js'
import {buildSubscriptionsKeyboard} from '@modules/subscriptions/telegram/keyboards/subscriptions.js'
import {staticCallback, subscriptionsPageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {type CallbackQueryContext, InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const subscriptionsCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  let {page} = subscriptionsPageRoute.parse(ctx.match)
  const limit = getRuntime().config.chatsPerPage
  const totalSubscriptions = await getUserActiveSubscriptionsCount(ctx.user.id)

  if (totalSubscriptions === 0) {
    return ctx.editMessageText(ctx.t('subscriptions.empty'), {
      reply_markup: new InlineKeyboard().text(ctx.t('button.back'), staticCallback.wallet),
    })
  }
  if (totalSubscriptions <= (page - 1) * limit) page = Math.ceil(totalSubscriptions / limit)

  const subscriptions = await getUserActiveSubscriptions(ctx.user.id, page, limit)
  const hasNext = totalSubscriptions > page * limit
  return ctx.editMessageText(ctx.t('subscriptions'), {
    reply_markup: buildSubscriptionsKeyboard(ctx.t, subscriptions, page, hasNext),
  })
}
