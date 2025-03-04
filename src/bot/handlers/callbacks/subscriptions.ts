import type {CallbackQueryContext} from 'grammy'
import {config} from '../../../config.js'
import {
  getUserActiveSubscriptions,
  getUserActiveSubscriptionsCount,
} from '../../../models/subscriptions.js'
import type {BotContext} from '../../context.js'
import {buildSubscriptionsKeyboard} from '../../helpers/keyboards/subscriptions.js'

export const subscriptionsCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  let {page} = parseMatch(ctx.match)
  const limit = config.chatsPerPage
  const totalSubscriptions = await getUserActiveSubscriptionsCount(ctx.user.id)

  if (totalSubscriptions === 0) return ctx.editMessageText(ctx.t('subscriptions.empty'))
  if (totalSubscriptions <= (page - 1) * limit) page = Math.ceil(totalSubscriptions / limit)

  const subscriptions = await getUserActiveSubscriptions(ctx.user.id, page, limit)
  const hasNext = totalSubscriptions > page * limit
  return ctx.editMessageText(ctx.t('subscriptions'), {
    reply_markup: buildSubscriptionsKeyboard(ctx.t, subscriptions, page, hasNext),
  })
}

function parseMatch(match: string | RegExpMatchArray) {
  const [, strPage] = match
  const page = parseInt(strPage!)
  if (isNaN(page) || page <= 0) return {page: 1}
  return {page}
}
