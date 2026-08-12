import {buildSendMenuKeyboard} from '@modules/wallet/telegram/keyboards/send-menu.js'
import type {BotContext} from '@telegram/context.js'
import type {ConversationHost} from '@telegram/helpers/conversation-host.js'

export function editMessageWithSendMenu(ctx: BotContext) {
  return ctx.editMessageText(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}

export function editHostWithSendMenu(ctx: BotContext, host: ConversationHost) {
  return ctx.api.editMessageText(host.chatId, host.messageId, ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}

export function replyWithSendMenu(ctx: BotContext) {
  return ctx.reply(ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
  })
}
