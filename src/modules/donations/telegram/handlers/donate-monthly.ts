import {advanceMonthlyNextAt, isValidDonationAmountSats} from '@core/money/donation.js'
import {
  buildDonateHubKeyboard,
  buildDonateMonthlyKeyboard,
} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {donateMonthlyAmountRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateMonthlyMenuCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  await ctx.editMessageText(ctx.t('donate.monthly-menu', {sats: user.monthlyDonationSats}), {
    reply_markup: buildDonateMonthlyKeyboard(ctx.t, user),
  })
  await ctx.answerCallbackQuery()
}

export async function donateMonthlyDisableCallback(ctx: BotContext) {
  await getRuntime().users.update(ctx.user.id, {
    monthlyDonationSats: 0,
    monthlyDonationNextAt: null,
    monthlyDonationLastHash: null,
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
    await ctx.reply(ctx.t('donate.invalid-amount'))
    return
  }

  const {users, donationPay} = getRuntime()
  const current = await users.getOrThrow(ctx.user.id)
  const wasOff = current.monthlyDonationSats <= 0
  const now = new Date()

  if (!wasOff && current.monthlyDonationNextAt && current.monthlyDonationNextAt > now) {
    // Change amount only; keep schedule (no surprise charge).
    await users.update(ctx.user.id, {monthlyDonationSats: amountSats})
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
    })

    if (result.status === 'paid') {
      const nextAt = advanceMonthlyNextAt(now, now)
      await users.update(ctx.user.id, {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: nextAt,
        monthlyDonationLastHash: result.paymentHash ?? null,
      })
      await ctx.reply(ctx.t('donate.monthly-enabled', {sats: amountSats}))
    } else {
      // Leave enabled with nextAt=now so cron retries.
      await users.update(ctx.user.id, {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: now,
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
