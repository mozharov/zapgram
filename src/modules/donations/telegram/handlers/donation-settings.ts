import {clampDonationPercent} from '@core/money/donation.js'
import {buildDonationSettingsKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {formatDonationSettingsText} from '@modules/donations/telegram/messages/donate-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {donationPercentRoute, donationScopeRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {getRuntime} from '../../../../runtime.js'

/** Auto-% screen nested under the unified support hub. */
export async function donationSettingsCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  captureBotEvent(getRuntime().posthog, 'donation_settings_opened', {
    feature: 'donations',
    donation_percent: user.donationPercent,
    donation_scope: user.donationScope,
    source: 'hub_or_settings',
  })
  await showLivingMenu(ctx, () =>
    ctx.reply(formatDonationSettingsText(ctx.t, user), {
      reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
    }),
  )
  await ctx.answerCallbackQuery()
}

export async function donationPercentCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {percent} = donationPercentRoute.parse(data)
  const clamped = clampDonationPercent(percent)
  const previous = ctx.user.donationPercent
  const user = await getRuntime().users.update(ctx.user.id, {donationPercent: clamped})
  ctx.log.info({donationPercent: clamped, previous}, 'Donation percent updated')
  captureBotEvent(getRuntime().posthog, 'donation_percent_set', {
    feature: 'donations',
    donation_percent: clamped,
    previous_donation_percent: previous,
    donation_scope: user.donationScope,
    source: 'preset',
    $set: {
      donation_percent: clamped,
      donation_scope: user.donationScope,
    },
  })
  await showLivingMenu(ctx, () =>
    ctx.reply(formatDonationSettingsText(ctx.t, user), {
      reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
    }),
  )
  await ctx.answerCallbackQuery({
    text: ctx.t('settings-donation.percent-set', {percent: clamped}),
  })
}

export async function donationScopeCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {scope} = donationScopeRoute.parse(data)
  const previous = ctx.user.donationScope
  const user = await getRuntime().users.update(ctx.user.id, {donationScope: scope})
  ctx.log.info({donationScope: scope, previous}, 'Donation scope updated')
  captureBotEvent(getRuntime().posthog, 'donation_scope_set', {
    feature: 'donations',
    donation_scope: scope,
    previous_donation_scope: previous,
    donation_percent: user.donationPercent,
    $set: {
      donation_percent: user.donationPercent,
      donation_scope: scope,
    },
  })
  await showLivingMenu(ctx, () =>
    ctx.reply(formatDonationSettingsText(ctx.t, user), {
      reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
    }),
  )
  await ctx.answerCallbackQuery({
    text:
      scope === 'tips'
        ? ctx.t('settings-donation.scope-tips-toast')
        : ctx.t('settings-donation.scope-all-toast'),
  })
}
