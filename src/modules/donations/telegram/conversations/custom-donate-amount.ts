import {isValidDonationAmountSats} from '@core/money/donation.js'
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

export async function customDonateAmount(conversation: BotConversation, ctx: ConversationContext) {
  const html = ctx.t('donate.custom-amount')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.donate-one-shot'),
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
          flow: 'one_shot',
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

  await conversation.external(() =>
    captureBotEvent(getRuntime().posthog, 'donate_one_shot_requested', {
      feature: 'donations',
      flow: 'one_shot',
      source: 'custom',
      amount_sats: sats,
      has_nwc: Boolean(ctx.user.nwc || ctx.user.nwcUrl),
    }),
  )

  await ctx.replyWithChatAction('typing')
  const result = await conversation.external(() =>
    getRuntime().donationPay.payDonation({
      userId: ctx.user.id,
      amountSats: sats,
      kind: 'one_shot',
      rail: 'auto',
      nwc: ctx.user.nwc,
      nwcUrl: ctx.user.nwcUrl,
      analytics: {source: 'donate_custom'},
    }),
  )

  const usdSuffix = await conversation.external(() => usdSuffixForSats(sats))
  if (result.status !== 'paid') {
    await conversation.external(() =>
      captureBotEvent(getRuntime().posthog, 'donate_one_shot_ui_failed', {
        feature: 'donations',
        flow: 'one_shot',
        source: 'custom',
        amount_sats: sats,
        reason: result.reason,
      }),
    )
    await ctx.reply(ctx.t('donate.failed', {sats, usdSuffix}))
    await replyDonateHub(ctx)
    return
  }

  await ctx.reply(ctx.t('donate.success', {sats, usdSuffix}))
  await replyDonateHub(ctx)
}
