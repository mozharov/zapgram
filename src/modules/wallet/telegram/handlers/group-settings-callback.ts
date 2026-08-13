import {chatsPageRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {editLivingMenu} from '@telegram/helpers/living-menu.js'
import {InlineKeyboard} from 'grammy'

export async function groupSettingsCallback(ctx: BotContext) {
  const keyboard = new InlineKeyboard()
    .row({
      url: `https://t.me/${ctx.me.username}?startgroup=true`,
      text: ctx.t('button.add-to-group'),
    })
    .row({
      callback_data: chatsPageRoute.build({page: 1}),
      text: ctx.t('button.paid-chats'),
    })
    .row({
      callback_data: staticCallback.wallet,
      text: ctx.t('button.back'),
    })

  await editLivingMenu(ctx, () =>
    ctx.editMessageText(ctx.t('settings.groups'), {reply_markup: keyboard}),
  )
}
