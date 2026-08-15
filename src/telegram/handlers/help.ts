import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {InlineKeyboard} from 'grammy'

export function helpCommand(ctx: BotContext) {
  return showLivingMenu(ctx, () =>
    ctx.replyWithRichMessage(
      {html: ctx.t('help')},
      {
        reply_markup: new InlineKeyboard([
          [{callback_data: staticCallback.wallet, text: ctx.t('button.back')}],
        ]),
      },
    ),
  )
}
