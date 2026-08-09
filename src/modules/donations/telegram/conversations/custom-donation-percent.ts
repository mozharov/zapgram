import {clampDonationPercent} from '@core/money/donation.js'
import {buildDonationSettingsKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {formatDonationSettingsText} from '@modules/donations/telegram/messages/donate-hub.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function customDonationPercent(
  conversation: BotConversation,
  ctx: ConversationContext,
) {
  const message = await ctx.reply(ctx.t('settings-donation.custom-percent-prompt'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const raw = await conversation.form.int({
    otherwise: async c => {
      await removeInlineKeyboard(message)
      if (c.update.message?.text) await c.reply(c.t('settings-donation.invalid-percent'))
      await c.reply(c.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))
  if (raw < 0 || raw > 100) {
    await ctx.reply(ctx.t('settings-donation.invalid-percent'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  const percent = clampDonationPercent(raw)
  const user = await conversation.external(() =>
    getRuntime().users.update(ctx.user.id, {donationPercent: percent}),
  )
  await ctx.reply(ctx.t('settings-donation.percent-set', {percent}))
  await ctx.reply(formatDonationSettingsText(ctx.t, user), {
    reply_markup: buildDonationSettingsKeyboard(ctx.t, user),
  })
}
