import {
  getUserActiveSubscriptions,
  getUserActiveSubscriptionsCount,
} from '@modules/subscriptions/repository.js'
import {buildSubscriptionsKeyboard} from '@modules/subscriptions/telegram/keyboards/subscriptions.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const subscriptionsCommand = async (ctx: BotContext) => {
  const limit = getRuntime().config.chatsPerPage
  const totalSubscriptions = await getUserActiveSubscriptionsCount(ctx.user.id)

  if (totalSubscriptions === 0) {
    return showLivingMenu(ctx, () =>
      ctx.reply(ctx.t('subscriptions.empty'), {
        reply_markup: new InlineKeyboard().text(ctx.t('button.back'), staticCallback.wallet),
      }),
    )
  }

  const subscriptions = await getUserActiveSubscriptions(ctx.user.id, 1, limit)
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('subscriptions'), {
      reply_markup: buildSubscriptionsKeyboard(ctx.t, subscriptions, 1, totalSubscriptions > limit),
    }),
  )
}
