import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function helpCallback(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('help'), {
    link_preview_options: {is_disabled: true},
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.wallet, text: ctx.t('button.back')}],
    ]),
  })
}
