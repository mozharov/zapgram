import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'

export function helpCallback(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('help'), {
    link_preview_options: {is_disabled: true},
    reply_markup: new InlineKeyboard([[{callback_data: 'wallet', text: ctx.t('button.back')}]]),
  })
}
