import type {BotContext} from '../../context.js'
import {buildSettingsKeyboard} from '../../helpers/keyboards/settings.js'

export const settingsCommand = (ctx: BotContext) => {
  return ctx.reply(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
  })
}
