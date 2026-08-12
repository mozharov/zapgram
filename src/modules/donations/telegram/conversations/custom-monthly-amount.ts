import {advanceMonthlyNextAt, isValidDonationAmountSats} from '@core/money/donation.js'
import {replyDonateHub} from '@modules/donations/telegram/reply-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customMonthlyAmount(conversation: BotConversation, ctx: ConversationContext) {
  const html = ctx.t('donate.monthly-custom-amount')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.donate-monthly'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let sats: number
  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyDonateHub(ctx)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const text = next.message?.text?.trim()
    const parsed = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(parsed) || !isValidDonationAmountSats(parsed)) {
      await conversation.external(() =>
        captureBotEvent(getRuntime().posthog, 'donation_invalid_amount', {
          feature: 'donations',
          flow: 'monthly',
          source: 'custom',
          amount_sats: Number.isFinite(parsed) ? parsed : null,
        }),
      )
      await next.reply(next.t('donate.invalid-amount'))
      continue
    }
    sats = parsed
    break
  }
  await clearPromptControls(conversation, prompt)

  const current = await conversation.external(() => getRuntime().users.getOrThrow(ctx.user.id))
  const wasOff = current.monthlyDonationSats <= 0
  const now = new Date()
  const usdSuffix = await conversation.external(() => usdSuffixForSats(sats))

  if (!wasOff && current.monthlyDonationNextAt && current.monthlyDonationNextAt > now) {
    await conversation.external(() =>
      getRuntime().users.update(ctx.user.id, {monthlyDonationSats: sats}),
    )
    await conversation.external(() =>
      captureBotEvent(getRuntime().posthog, 'monthly_donate_amount_updated', {
        feature: 'donations',
        flow: 'monthly',
        amount_sats: sats,
        previous_monthly_sats: current.monthlyDonationSats,
        next_at: current.monthlyDonationNextAt?.toISOString() ?? null,
        charged_now: false,
        source: 'custom',
        $set: {monthly_donation_sats: sats},
      }),
    )
    await ctx.reply(ctx.t('donate.monthly-amount-updated', {sats, usdSuffix}))
    await replyDonateHub(ctx)
    return
  }

  await ctx.replyWithChatAction('typing')
  const result = await conversation.external(() =>
    getRuntime().donationPay.payDonation({
      userId: ctx.user.id,
      amountSats: sats,
      kind: 'monthly',
      rail: 'auto',
      nwc: ctx.user.nwc,
      nwcUrl: ctx.user.nwcUrl,
      analytics: {
        source: wasOff ? 'monthly_enable_custom' : 'monthly_due_enable_custom',
        was_off: wasOff,
      },
    }),
  )
  if (result.status === 'paid') {
    const nextAt = advanceMonthlyNextAt(now, now)
    await conversation.external(() =>
      getRuntime().users.update(ctx.user.id, {
        monthlyDonationSats: sats,
        monthlyDonationNextAt: nextAt,
        monthlyDonationLastHash: result.paymentHash ?? null,
      }),
    )
    await conversation.external(() =>
      captureBotEvent(getRuntime().posthog, 'monthly_donate_enabled', {
        feature: 'donations',
        flow: 'monthly',
        amount_sats: sats,
        previous_monthly_sats: current.monthlyDonationSats,
        was_off: wasOff,
        charged_now: true,
        charge_status: 'paid',
        rail: result.rail,
        payment_hash: result.paymentHash ?? null,
        next_at: nextAt.toISOString(),
        source: 'custom',
        $set: {monthly_donation_sats: sats},
      }),
    )
    await ctx.reply(ctx.t('donate.monthly-enabled', {sats, usdSuffix}))
  } else {
    await conversation.external(() =>
      getRuntime().users.update(ctx.user.id, {
        monthlyDonationSats: sats,
        monthlyDonationNextAt: now,
      }),
    )
    await conversation.external(() =>
      captureBotEvent(getRuntime().posthog, 'monthly_donate_enabled', {
        feature: 'donations',
        flow: 'monthly',
        amount_sats: sats,
        previous_monthly_sats: current.monthlyDonationSats,
        was_off: wasOff,
        charged_now: true,
        charge_status: 'failed',
        reason: result.reason,
        next_at: now.toISOString(),
        source: 'custom',
        $set: {monthly_donation_sats: sats},
      }),
    )
    await ctx.reply(ctx.t('donate.monthly-enable-failed', {sats, usdSuffix}))
  }

  await replyDonateHub(ctx)
}
