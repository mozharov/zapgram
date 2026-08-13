import {buildDonateHubKeyboard} from '@modules/donations/telegram/keyboards/donate.js'
import {loadDonateHubStats} from '@modules/donations/telegram/load-hub.js'
import {formatDonateHubText} from '@modules/donations/telegram/messages/donate-hub.js'
import type {BotContext} from '@telegram/context.js'
import {editLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {getRuntime} from '../../../runtime.js'

/** Fresh support hub message (after payments / commands). */
export async function replyDonateHub(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  ctx.user = user as typeof ctx.user
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  return showLivingMenu(ctx, async () =>
    ctx.reply(await formatDonateHubText(ctx.t, user, stats, platform), {
      reply_markup: buildDonateHubKeyboard(ctx.t, user),
      link_preview_options: {is_disabled: true},
    }),
  )
}

/** In-place hub refresh (settings ↔ hub navigation). */
export async function editDonateHub(ctx: BotContext) {
  const user = await getRuntime().users.getOrThrow(ctx.user.id)
  ctx.user = user as typeof ctx.user
  const {user: stats, platform} = await loadDonateHubStats(ctx.user.id)
  const text = await formatDonateHubText(ctx.t, user, stats, platform)
  return editLivingMenu(ctx, () =>
    ctx.editMessageText(text, {
      reply_markup: buildDonateHubKeyboard(ctx.t, user),
      link_preview_options: {is_disabled: true},
    }),
  )
}

/**
 * Remove the callback hub so it does not stay stale after a payment attempt.
 * If Telegram refuses delete, strip the keyboard instead.
 */
export async function clearDonateCallbackMessage(ctx: BotContext): Promise<void> {
  try {
    await ctx.deleteMessage()
    return
  } catch (error) {
    getRuntime().log.warn({error}, 'Failed to delete donate hub message')
  }
  try {
    await ctx.editMessageReplyMarkup({reply_markup: {inline_keyboard: []}})
  } catch {
    // already gone or not editable
  }
}
