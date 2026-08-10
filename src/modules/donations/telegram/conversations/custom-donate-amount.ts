import {isValidDonationAmountSats} from '@core/money/donation.js'
import {replyDonateHub} from '@modules/donations/telegram/reply-hub.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customDonateAmount(conversation: BotConversation, ctx: ConversationContext) {
  // Clear the hub that launched this conversation so it does not stay stale.
  await conversation.external(async () => {
    try {
      await ctx.editMessageReplyMarkup({reply_markup: {inline_keyboard: []}})
    } catch {
      // may already be a plain message
    }
  })

  const message = await ctx.reply(ctx.t('donate.custom-amount'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const sats = await conversation.form.int({
    otherwise: async c => {
      await removeInlineKeyboard(message)
      if (c.update.message?.text) await c.reply(c.t('donate.invalid-amount'))
      await c.reply(c.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))
  if (!isValidDonationAmountSats(sats)) {
    await conversation.external(() =>
      captureBotEvent(getRuntime().posthog, 'donation_invalid_amount', {
        feature: 'donations',
        flow: 'one_shot',
        source: 'custom',
        amount_sats: sats,
      }),
    )
    await ctx.reply(ctx.t('donate.invalid-amount'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

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
