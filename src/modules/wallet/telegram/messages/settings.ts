import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'

export function editMessageWithSettings(ctx: BotContext) {
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('settings'), {
      reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
    }),
  )
}

export function replyWithSettings(ctx: BotContext) {
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('settings'), {
      reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
    }),
  )
}
