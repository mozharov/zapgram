import {InlineKeyboard} from 'grammy'
import type {BotContext} from '../../context.js'

export async function groupSettingsCallback(ctx: BotContext) {
  const keyboard = new InlineKeyboard()
    .row({
      url: `https://t.me/${ctx.me.username}?startgroup=true`,
      text: ctx.t('button.add-to-group'),
    })
    .row({
      callback_data: 'settings',
      text: ctx.t('button.back'),
    })

  await ctx.editMessageText(ctx.t('settings.groups'), {reply_markup: keyboard})
}
