import {buildSendMenuKeyboard} from '@modules/wallet/telegram/keyboards/send-menu.js'
import type {BotContext} from '@telegram/context.js'

export function editMessageWithSendMenu(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}

export function replyWithSendMenu(ctx: BotContext) {
  return ctx.reply(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}
