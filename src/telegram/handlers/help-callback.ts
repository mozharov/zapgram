import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function helpCallback(ctx: BotContext) {
  return ctx.editMessageText(
    {html: ctx.t('help')},
    {
      reply_markup: new InlineKeyboard([
        [{callback_data: staticCallback.wallet, text: ctx.t('button.back')}],
      ]),
    },
  )
}
