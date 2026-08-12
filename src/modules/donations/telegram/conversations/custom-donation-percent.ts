import {clampDonationPercent} from '@core/money/donation.js'
import {buildDonationSettingsKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {formatDonationSettingsText} from '@modules/donations/telegram/messages/donate-hub.js'
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
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customDonationPercent(
  conversation: BotConversation,
  ctx: ConversationContext,
) {
  const html = ctx.t('settings-donation.custom-percent-prompt')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.donation-percent'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let raw: number
  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      const user = await conversation.external(() => getRuntime().users.getOrThrow(ctx.user.id))
      await ctx.reply(formatDonationSettingsText(ctx.t, user), {
        reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
      })
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const text = next.message?.text?.trim()
    const parsed = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
      await conversation.external(() =>
        captureBotEvent(getRuntime().posthog, 'donation_invalid_percent', {
          feature: 'donations',
          source: 'custom',
          raw_percent: Number.isFinite(parsed) ? parsed : null,
        }),
      )
      await next.reply(next.t('settings-donation.invalid-percent'))
      continue
    }
    raw = parsed
    break
  }
  await clearPromptControls(conversation, prompt)

  const percent = clampDonationPercent(raw)
  const previous = ctx.user.donationPercent
  const user = await conversation.external(() =>
    getRuntime().users.update(ctx.user.id, {donationPercent: percent}),
  )
  await conversation.external(() =>
    captureBotEvent(getRuntime().posthog, 'donation_percent_set', {
      feature: 'donations',
      donation_percent: percent,
      previous_donation_percent: previous,
      donation_scope: user.donationScope,
      source: 'custom',
      $set: {
        donation_percent: percent,
        donation_scope: user.donationScope,
      },
    }),
  )
  await ctx.reply(ctx.t('settings-donation.percent-set', {percent}))
  // Return to auto-% screen (still under the support hub via Back).
  await ctx.reply(formatDonationSettingsText(ctx.t, user), {
    reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
  })
}
