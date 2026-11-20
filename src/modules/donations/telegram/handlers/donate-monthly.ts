import {SendPausedError} from '@core/errors/send-paused.js'
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
import {editLivingMenu} from '@telegram/helpers/living-menu.js'
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
  const text = ctx.t('donate.monthly-menu', {
    sats: user.monthlyDonationSats,
    usdSuffix: await usdSuffixForSats(user.monthlyDonationSats),
  })
  await editLivingMenu(ctx, () =>
    ctx.editMessageText(text, {reply_markup: buildDonateMonthlyKeyboard(ctx.t, user)}),
  )
  await ctx.answerCallbackQuery()
}

export async function donateMonthlyDisableCallback(ctx: BotContext) {
  const previousSats = ctx.user.monthlyDonationSats
  const previousNextAt = ctx.user.monthlyDonationNextAt
  await getRuntime().users.update(ctx.user.id, {
    monthlyDonationSats: 0,
    monthlyDonationNextAt: null,
  })
  ctx.log.info('Monthly donation disabled')
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

  // A due payment may already be in flight. Let cron reconcile it before changing the amount.
  if (current.monthlyDonationLastHash) {
    await ctx.reply(
      ctx.t(
        current.monthlyDonationSats > 0
          ? 'donate.monthly-pending'
          : 'donate.previous-payment-pending',
        {
          sats: current.monthlyDonationSats,
          usdSuffix: await usdSuffixForSats(current.monthlyDonationSats),
        },
      ),
    )
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

  if (result.status === 'skipped') {
    await replyDonateHub(ctx)
    return
  }

  if (result.status === 'paid') {
    const nextAt = advanceMonthlyNextAt(now, now)
    const updated = await users.updateMonthlyDonationIfDue(
      ctx.user.id,
      result.paymentHash,
      {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: nextAt,
        monthlyDonationLastHash: null,
        monthlyDonationExpiresAt: null,
      },
      now,
    )
    if (!updated)
      ctx.log.warn(
        {paymentHash: result.paymentHash, rail: result.rail},
        'Paid monthly donation schedule update skipped: slot changed',
      )
    else ctx.log.info({nextAt}, 'Monthly donation period finalized')
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
  } else if (result.status === 'pending') {
    const pendingSats = result.existing ? (result.amountSats ?? 0) : amountSats
    await ctx.reply(
      ctx.t(pendingSats > 0 ? 'donate.monthly-pending' : 'donate.previous-payment-pending', {
        sats: pendingSats,
        usdSuffix: await usdSuffixForSats(pendingSats),
      }),
    )
  } else {
    const updated = await users.updateMonthlyDonationIfDue(
      ctx.user.id,
      null,
      {
        monthlyDonationSats: amountSats,
        monthlyDonationNextAt: now,
      },
      now,
    )
    if (!updated) ctx.log.warn('Failed monthly donation settings update skipped: period changed')
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
    // The row is already saved, so the cron retries after the backend can pay again.
    const paused = result.error instanceof SendPausedError
    await ctx.reply(
      ctx.t(paused ? 'donate.monthly-paused' : 'donate.monthly-enable-failed', {
        sats: amountSats,
        usdSuffix,
      }),
    )
  }

  await replyDonateHub(ctx)
}
