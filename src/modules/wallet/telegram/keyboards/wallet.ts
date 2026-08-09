import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function buildWalletKeyboard(t: BotContext['t']) {
  return new InlineKeyboard()
    .add({callback_data: staticCallback.createInvoice, text: t('button.receive')})
    .add({callback_data: staticCallback.sendMenu, text: t('button.send')})
    .row({callback_data: staticCallback.settings, text: t('button.settings')})
    .add({callback_data: staticCallback.help, text: t('button.help')})
    .row({callback_data: staticCallback.donate, text: t('button.donate')})
}
