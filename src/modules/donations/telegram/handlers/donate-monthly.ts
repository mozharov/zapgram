import {advanceMonthlyNextAt, isValidDonationAmountSats} from '@core/money/donation.js'
import {
  buildDonateHubKeyboard,
  buildDonateMonthlyKeyboard,
} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {donateMonthlyAmountRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateMonthlyMenuCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  captureBotEvent(getRuntime().posthog, 'donate_monthly_menu_opened', {
    feature: 'donations',
    flow: 'monthly',
    monthly_donation_sats: user.monthlyDonationSats,
    monthly_donation_next_at: user.monthlyDonationNextAt?.toISOString() ?? null,
  })
  await ctx.editMessageText(ctx.t('donate.monthly-menu', {sats: user.monthlyDonationSats}), {
    reply_markup: buildDonateMonthlyKeyboard(ctx.t, user),
  })
  await ctx.answerCallbackQuery()
}

export async function donateMonthlyDisableCallback(ctx: BotContext) {
  const previousSats = ctx.user.monthlyDonationSats
  const previousNextAt = ctx.user.monthlyDonationNextAt
  await getRuntime().users.update(ctx.user.id, {
    monthlyDonationSats: 0,
    monthlyDonationNextAt: null,
    monthlyDonationLastHash: null,
  })
  captureBotEvent(getRuntime().posthog, 'monthly_donate_disabled', {
    feature: 'donations',
    flow: 'monthly',
    previous_monthly_sats: previousSats,
    previous_next_at: previousNextAt?.toISOString() ?? null,
    $set: {monthly_donation_sats: 0},
  })
  await ctx.answerCallbackQuery({text: ctx.t('donate.monthly-disabled-toast')})
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.editMessageText(formatDonateHubText(ctx.t, user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}

/**
 * Enable or change monthly amount.
 * First enable from 0 → charge now; amount change with future nextAt → no immediate charge.
 */
export async function donateMonthlyAmountCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {amountSats} = donateMonthlyAmountRoute.parse(data)
  await ctx.answerCallbackQuery()

  if (!isValidDonationAmountSats(amountSats)) {
    captureBotEvent(getRuntime().posthog, 'donation_invalid_amount', {
      feature: 'donations',
      flow: 'monthly',
      source: 'preset',
      amount_sats: amountSats,
    })
    await ctx.reply(ctx.t('donate.invalid-amount'))
    return
  }

  const {users, donationPay, posthog} = getRuntime()
  const current = await users.getOrThrow(ctx.user.id)
  const wasOff = current.monthlyDonationSats <= 0
  const now = new Date()

  if (!wasOff && current.monthlyDonationNextAt && current.monthlyDonationNextAt > now) {
    // Change amount only; keep schedule (no surprise charge).
    await users.update(ctx.user.id, {monthlyDonationSats: amountSats})
    captureBotEvent(posthog, 'monthly_donate_amount_updated', {
      feature: 'donations',
      flow: 'monthly',
      amount_sats: amountSats,
      previous_monthly_sats: current.monthlyDonationSats,
      next_at: current.monthlyDonationNextAt.toISOString(),
      charged_now: false,
      source: 'preset',
      $set: {monthly_donation_sats: amountSats},
    })
    await ctx.reply(ctx.t('donate.monthly-amount-updated', {sats: amountSats}))
  } else {
    // First enable or already due → charge immediately.
    await ctx.replyWithChatAction('typing').catch(() => null)
    const result = await donationPay.payDonation({
      userId: ctx.user.id,
      amountSats,
      kind: 'monthly',
      rail: 'auto',
      nwc: ctx.user.nwc,
      nwcUrl: ctx.user.nwcUrl,
      analytics: {source: wasOff ? 'monthly_enable' : 'monthly_due_enable', was_off: wasOff},
    })

    if (result.status === 'paid') {
      const nextAt = advanceMonthlyNextAt(now, now)
      await users.update(ctx.user.id, {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: nextAt,
        monthlyDonationLastHash: result.paymentHash ?? null,
      })
      captureBotEvent(posthog, 'monthly_donate_enabled', {
        feature: 'donations',
        flow: 'monthly',
        amount_sats: amountSats,
        previous_monthly_sats: current.monthlyDonationSats,
        was_off: wasOff,
        charged_now: true,
        charge_status: 'paid',
        rail: result.rail,
        payment_hash: result.paymentHash ?? null,
        next_at: nextAt.toISOString(),
        source: 'preset',
        $set: {monthly_donation_sats: amountSats},
      })
      await ctx.reply(ctx.t('donate.monthly-enabled', {sats: amountSats}))
    } else {
      // Leave enabled with nextAt=now so cron retries.
      await users.update(ctx.user.id, {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: now,
      })
      captureBotEvent(posthog, 'monthly_donate_enabled', {
        feature: 'donations',
        flow: 'monthly',
        amount_sats: amountSats,
        previous_monthly_sats: current.monthlyDonationSats,
        was_off: wasOff,
        charged_now: true,
        charge_status: 'failed',
        reason: result.reason,
        next_at: now.toISOString(),
        source: 'preset',
        $set: {monthly_donation_sats: amountSats},
      })
      await ctx.reply(ctx.t('donate.monthly-enable-failed', {sats: amountSats}))
    }
  }

  const user = await users.getOrThrow(ctx.user.id)
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.reply(formatDonateHubText(ctx.t, user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}
