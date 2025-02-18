import type {BotContext} from '../../context.js'
import {buildSendMenuKeyboard} from '../../helpers/keyboards/send-menu.js'

export const sendMenuCallback = async (ctx: BotContext) => {
  await ctx.editMessageText(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}
