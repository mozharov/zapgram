import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import type {BotContext} from '@telegram/context.js'

export function settingsCallback(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, ctx.user),
  })
}
