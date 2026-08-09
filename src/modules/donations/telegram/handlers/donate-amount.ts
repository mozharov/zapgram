import {isValidDonationAmountSats} from '@core/money/donation.js'
import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import {donateAmountRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateAmountCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data
  if (!data) return
  const {amountSats} = donateAmountRoute.parse(data)
  await ctx.answerCallbackQuery()

  if (!isValidDonationAmountSats(amountSats)) {
    await ctx.reply(ctx.t('donate.invalid-amount'))
    return
  }

  await ctx.replyWithChatAction('typing').catch(() => null)
  const {donationPay, users} = getRuntime()
  const result = await donationPay.payDonation({
    userId: ctx.user.id,
    amountSats,
    kind: 'one_shot',
    rail: 'auto',
    nwc: ctx.user.nwc,
    nwcUrl: ctx.user.nwcUrl,
  })

  if (result.status !== 'paid') {
    await ctx.reply(ctx.t('donate.failed', {sats: amountSats}))
    return
  }

  await ctx.reply(ctx.t('donate.success', {sats: amountSats}))
  const user = await users.getOrThrow(ctx.user.id)
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.reply(formatDonateHubText(ctx.t, user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}
