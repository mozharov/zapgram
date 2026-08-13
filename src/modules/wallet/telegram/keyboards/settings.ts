import type {User} from '@infra/db/types.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function buildSettingsKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()

  if (user.nwcUrl) {
    const nwcTipsText = user.nwcTips ? t('button.disable-nwc-tips') : t('button.enable-nwc-tips')
    keyboard
      .row({
        callback_data: staticCallback.toggleNwcTips,
        text: nwcTipsText,
      })
      .row({
        callback_data: staticCallback.disconnectNwc,
        text: t('button.disconnect-nwc'),
      })
  } else keyboard.row({callback_data: staticCallback.connectNwc, text: t('button.connect-nwc')})

  keyboard.row({
    callback_data: staticCallback.wallet,
    text: t('button.back'),
  })

  return keyboard
}
