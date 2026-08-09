import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {editDonateHub, replyDonateHub} from '@modules/donations/telegram/reply-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateCommand(ctx: BotContext) {
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  captureBotEvent(getRuntime().posthog, 'donate_hub_opened', {
    feature: 'donations',
    source: 'command',
    user_total_sats: stats.totalSats,
    user_count: stats.count,
    platform_total_sats: platform.totalSats,
    platform_last_month_sats: platform.lastMonthSats,
    monthly_donation_sats: ctx.user.monthlyDonationSats,
    donation_percent: ctx.user.donationPercent,
    donation_scope: ctx.user.donationScope,
  })
  await replyDonateHub(ctx)
}

export async function donateHubCallback(ctx: BotContext) {
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  captureBotEvent(getRuntime().posthog, 'donate_hub_opened', {
    feature: 'donations',
    source: 'callback',
    user_total_sats: stats.totalSats,
    user_count: stats.count,
    platform_total_sats: platform.totalSats,
    platform_last_month_sats: platform.lastMonthSats,
    monthly_donation_sats: user.monthlyDonationSats,
    donation_percent: user.donationPercent,
    donation_scope: user.donationScope,
  })
  await editDonateHub(ctx)
  await ctx.answerCallbackQuery()
}
