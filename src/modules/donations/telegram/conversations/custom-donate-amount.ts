import {isValidDonationAmountSats} from '@core/money/donation.js'
import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customDonateAmount(conversation: BotConversation, ctx: ConversationContext) {
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
    await ctx.reply(ctx.t('donate.invalid-amount'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  await ctx.replyWithChatAction('typing')
  const result = await conversation.external(() =>
    getRuntime().donationPay.payDonation({
      userId: ctx.user.id,
      amountSats: sats,
      kind: 'one_shot',
      rail: 'auto',
      nwc: ctx.user.nwc,
      nwcUrl: ctx.user.nwcUrl,
    }),
  )

  if (result.status !== 'paid') {
    await ctx.reply(ctx.t('donate.failed', {sats}))
    return
  }

  await ctx.reply(ctx.t('donate.success', {sats}))
  const user = await conversation.external(() => getRuntime().users.getOrThrow(ctx.user.id))
  const hub = await conversation.external(() => loadDonateHubStats(ctx.user.id))
  await ctx.reply(formatDonateHubText(ctx.t, user, hub.user, hub.platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}
