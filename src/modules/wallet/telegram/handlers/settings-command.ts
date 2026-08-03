import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import type {BotContext} from '@telegram/context.js'

export const settingsCommand = (ctx: BotContext) => {
  return ctx.reply(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
  })
}
