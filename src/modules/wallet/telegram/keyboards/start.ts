import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function buildStartKeyboard(t: BotContext['t']) {
  return new InlineKeyboard()
    .text(t('button.open-wallet'), staticCallback.wallet)
    .text(t('button.how-it-works'), staticCallback.help)
}
