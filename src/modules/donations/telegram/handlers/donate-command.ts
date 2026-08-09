import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function donateCommand(ctx: BotContext) {
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.reply(formatDonateHubText(ctx.t, ctx.user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
}

export async function donateHubCallback(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  ctx.user = user as typeof ctx.user
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  await ctx.editMessageText(formatDonateHubText(ctx.t, user, stats, platform), {
    reply_markup: buildDonateHubKeyboard(ctx.t),
  })
  await ctx.answerCallbackQuery()
}
