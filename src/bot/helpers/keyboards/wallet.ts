import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'

export function buildWalletKeyboard(t: BotContext['t']) {
  return new InlineKeyboard()
    .add({callback_data: 'create-invoice', text: t('button.receive')})
    .add({callback_data: 'send-menu', text: t('button.send')})
    .row({callback_data: 'settings', text: t('button.settings')})
    .add({callback_data: 'help', text: t('button.help')})
}
