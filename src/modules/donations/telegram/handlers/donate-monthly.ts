import {advanceMonthlyNextAt, isValidDonationAmountSats} from '@core/money/donation.js'
import {buildDonateMonthlyKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {
  clearDonateCallbackMessage,
  editDonateHub,
  replyDonateHub,
} from '@modules/donations/telegram/reply-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {donateMonthlyAmountRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateMonthlyMenuCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  captureBotEvent(getRuntime().posthog, 'donate_monthly_menu_opened', {
    feature: 'donations',
    flow: 'monthly',
    monthly_donation_sats: user.monthlyDonationSats,
    monthly_donation_next_at: user.monthlyDonationNextAt?.toISOString() ?? null,
  })
  await showLivingMenu(ctx, async () =>
    ctx.reply(
      ctx.t('donate.monthly-menu', {
        sats: user.monthlyDonationSats,
        usdSuffix: await usdSuffixForSats(user.monthlyDonationSats),
      }),
      {
        reply_markup: buildDonateMonthlyKeyboard(ctx.t, user),
      },
    ),
  )
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
  await editDonateHub(ctx)
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

  await clearDonateCallbackMessage(ctx)

  const usdSuffix = await usdSuffixForSats(amountSats)

  if (!wasOff && current.monthlyDonationNextAt && current.monthlyDonationNextAt > now) {
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
    await ctx.reply(ctx.t('donate.monthly-amount-updated', {sats: amountSats, usdSuffix}))
    await replyDonateHub(ctx)
    return
  }

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
    await ctx.reply(ctx.t('donate.monthly-enabled', {sats: amountSats, usdSuffix}))
  } else {
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
    await ctx.reply(ctx.t('donate.monthly-enable-failed', {sats: amountSats, usdSuffix}))
  }

  await replyDonateHub(ctx)
}
