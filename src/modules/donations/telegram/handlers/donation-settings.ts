import {clampDonationPercent} from '@core/money/donation.js'
import {buildDonationSettingsKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {formatDonationSettingsText} from '@modules/donations/telegram/messages/donate-hub.js'
import {donationPercentRoute, donationScopeRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donationSettingsCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  await ctx.editMessageText(formatDonationSettingsText(ctx.t, user), {
    reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
  })
  await ctx.answerCallbackQuery()
}

export async function donationPercentCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {percent} = donationPercentRoute.parse(data)
  const clamped = clampDonationPercent(percent)
  const user = await getRuntime().users.update(ctx.user.id, {donationPercent: clamped})
  await ctx.editMessageText(formatDonationSettingsText(ctx.t, user), {
    reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
  })
  await ctx.answerCallbackQuery({
    text: ctx.t('settings-donation.percent-set', {percent: clamped}),
  })
}

export async function donationScopeCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {scope} = donationScopeRoute.parse(data)
  const user = await getRuntime().users.update(ctx.user.id, {donationScope: scope})
  await ctx.editMessageText(formatDonationSettingsText(ctx.t, user), {
    reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
  })
  await ctx.answerCallbackQuery({
    text:
      scope === 'tips'
        ? ctx.t('settings-donation.scope-tips-toast')
        : ctx.t('settings-donation.scope-all-toast'),
  })
}
