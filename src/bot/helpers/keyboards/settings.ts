import type {User} from '../../../lib/database/types.js'
import type {BotContext} from '../../context.js'
import {InlineKeyboard} from 'grammy'

export function buildSettingsKeyboard(t: BotContext['t'], user: User) {
  const keyboard = new InlineKeyboard()

  if (user.nwcUrl) {
    const nwcTipsText = user.nwcTips ? t('button.disable-nwc-tips') : t('button.enable-nwc-tips')
    keyboard
      .row({
        callback_data: 'toggle-nwc-tips',
        text: nwcTipsText,
      })
      .row({
        callback_data: 'disconnect-nwc',
        text: t('button.disconnect-nwc'),
      })
  } else keyboard.row({callback_data: 'connect-nwc', text: t('button.connect-nwc')})

  keyboard
    .row({
      callback_data: 'group-settings',
      text: t('button.groups'),
    })
    .row({
      callback_data: 'wallet',
      text: t('button.back'),
    })

  return keyboard
}
