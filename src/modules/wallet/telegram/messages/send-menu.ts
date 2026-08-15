import {buildSendMenuKeyboard} from '@modules/wallet/telegram/keyboards/send-menu.js'
import type {BotContext} from '@telegram/context.js'
import {type ConversationHost, disabledLinkPreview} from '@telegram/helpers/conversation-host.js'
import {editLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'

export function editMessageWithSendMenu(ctx: BotContext) {
  return editLivingMenu(ctx, () =>
    ctx.editMessageText(ctx.t('send-menu'), {
      reply_markup: buildSendMenuKeyboard(ctx.t),
      ...disabledLinkPreview,
    }),
  )
}

export function editHostWithSendMenu(ctx: BotContext, host: ConversationHost) {
  return ctx.api.editMessageText(host.chatId, host.messageId, ctx.t('send-menu'), {
    reply_markup: buildSendMenuKeyboard(ctx.t),
    ...disabledLinkPreview,
  })
}

export function replyWithSendMenu(ctx: BotContext) {
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('send-menu'), {
      reply_markup: buildSendMenuKeyboard(ctx.t),
      ...disabledLinkPreview,
    }),
  )
}
