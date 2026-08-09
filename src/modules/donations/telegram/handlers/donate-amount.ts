import {isValidDonationAmountSats} from '@core/money/donation.js'
import {clearDonateCallbackMessage, replyDonateHub} from '@modules/donations/telegram/reply-hub.js'
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

  // Drop the old hub so it does not sit under success with stale stats / buttons.
  await clearDonateCallbackMessage(ctx)
  await ctx.replyWithChatAction('typing').catch(() => null)

  const {donationPay, posthog} = getRuntime()
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
    await replyDonateHub(ctx)
    return
  }

  await ctx.reply(ctx.t('donate.success', {sats: amountSats}))
  await replyDonateHub(ctx)
}
