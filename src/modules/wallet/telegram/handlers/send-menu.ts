import {buildSendMenuKeyboard} from '@modules/wallet/telegram/keyboards/send-menu.js'
import type {BotContext} from '@telegram/context.js'

export const sendMenuCallback = async (ctx: BotContext) => {
  await ctx.editMessageText(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}
