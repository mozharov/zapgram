import {isValidDonationAmountSats} from '@core/money/donation.js'
import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {donateAmountRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateAmountCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {amountSats} = donateAmountRoute.parse(data)
  await ctx.answerCallbackQuery()

  if (!isValidDonationAmountSats(amountSats)) {
    captureBotEvent(getRuntime().posthog, 'donation_invalid_amount', {
      feature: 'donations',
      flow: 'one_shot',
      source: 'preset',
      amount_sats: amountSats,
    })
    await ctx.reply(ctx.t('donate.invalid-amount'))
    return
  }

  captureBotEvent(getRuntime().posthog, 'donate_one_shot_requested', {
    feature: 'donations',
    flow: 'one_shot',
    source: 'preset',
    amount_sats: amountSats,
    has_nwc: Boolean(ctx.user.nwc || ctx.user.nwcUrl),
  })

  await ctx.replyWithChatAction('typing').catch(() => null)
  const {donationPay, users, posthog} = getRuntime()
  const result = await donationPay.payDonation({
    userId: ctx.user.id,
    amountSats,
    kind: 'one_shot',
    rail: 'auto',
    nwc: ctx.user.nwc,
    nwcUrl: ctx.user.nwcUrl,
    analytics: {source: 'donate_preset'},
  })

  if (result.status !== 'paid') {
    captureBotEvent(posthog, 'donate_one_shot_ui_failed', {
      feature: 'donations',
      flow: 'one_shot',
      source: 'preset',
      amount_sats: amountSats,
      reason: result.reason,
    })
    await ctx.reply(ctx.t('donate.failed', {sats: amountSats}))
    return
  }

  await ctx.reply(ctx.t('donate.success', {sats: amountSats}))
  const user = await users.getOrThrow(ctx.user.id)
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.reply(formatDonateHubText(ctx.t, user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}
