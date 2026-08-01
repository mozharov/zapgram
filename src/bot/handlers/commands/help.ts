import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'

export function helpCommand(ctx: BotContext) {
  return ctx.reply(ctx.t('help'), {
    link_preview_options: {is_disabled: true},
    reply_markup: new InlineKeyboard([[{callback_data: 'wallet', text: ctx.t('button.back')}]]),
  })
}
