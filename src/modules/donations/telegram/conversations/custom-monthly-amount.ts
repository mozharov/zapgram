import {advanceMonthlyNextAt, isValidDonationAmountSats} from '@core/money/donation.js'
import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customMonthlyAmount(conversation: BotConversation, ctx: ConversationContext) {
  const message = await ctx.reply(ctx.t('donate.monthly-custom-amount'), {
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
    await ctx.reply(ctx.t('donate.invalid-amount'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  const current = await conversation.external(() => getRuntime().users.getOrThrow(ctx.user.id))
  const wasOff = current.monthlyDonationSats <= 0
  const now = new Date()

  if (!wasOff && current.monthlyDonationNextAt && current.monthlyDonationNextAt > now) {
    await conversation.external(() =>
      getRuntime().users.update(ctx.user.id, {monthlyDonationSats: sats}),
    )
    await ctx.reply(ctx.t('donate.monthly-amount-updated', {sats}))
  } else {
    await ctx.replyWithChatAction('typing')
    const result = await conversation.external(() =>
      getRuntime().donationPay.payDonation({
        userId: ctx.user.id,
        amountSats: sats,
        kind: 'monthly',
        rail: 'auto',
        nwc: ctx.user.nwc,
        nwcUrl: ctx.user.nwcUrl,
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
      await ctx.reply(ctx.t('donate.monthly-enabled', {sats}))
    } else {
      await conversation.external(() =>
        getRuntime().users.update(ctx.user.id, {
          monthlyDonationSats: sats,
          monthlyDonationNextAt: now,
        }),
      )
      await ctx.reply(ctx.t('donate.monthly-enable-failed', {sats}))
    }
  }

  const user = await conversation.external(() => getRuntime().users.getOrThrow(ctx.user.id))
  const hub = await conversation.external(() => loadDonateHubStats(ctx.user.id))
  await ctx.reply(formatDonateHubText(ctx.t, user, hub.user, hub.platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}
