import {
  broadcastConfirmRoute,
  broadcastLocaleRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {InlineKeyboard} from 'grammy'

export function buildBroadcastLocaleKeyboard(t: (key: string) => string): InlineKeyboard {
  return new InlineKeyboard([
    [
      {callback_data: broadcastLocaleRoute.build({locale: 'en'}), text: t('broadcast.locale-en')},
      {callback_data: broadcastLocaleRoute.build({locale: 'ru'}), text: t('broadcast.locale-ru')},
    ],
    [{callback_data: staticCallback.cancel, text: t('button.cancel')}],
  ])
}

export function buildBroadcastConfirmKeyboard(t: (key: string) => string): InlineKeyboard {
  return new InlineKeyboard([
    [
      {
        callback_data: broadcastConfirmRoute.build({action: 'yes'}),
        text: t('broadcast.confirm-yes'),
      },
      {
        callback_data: broadcastConfirmRoute.build({action: 'no'}),
        text: t('broadcast.confirm-no'),
      },
    ],
  ])
}
