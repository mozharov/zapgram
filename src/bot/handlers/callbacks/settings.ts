import type {BotContext} from '../../context.js'
import {buildSettingsKeyboard} from '../../helpers/keyboards/settings.js'

export function settingsCallback(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
  })
}
