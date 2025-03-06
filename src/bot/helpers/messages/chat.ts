import type {Chat} from '../../../lib/database/types.js'
import type {BotContext} from '../../context.js'
import {buildChatKeyboard} from '../keyboards/chat.js'

export async function editMessageWithChat(ctx: BotContext, chat: Chat) {
  await ctx.editMessageText(buildText(ctx.t, chat), {reply_markup: buildChatKeyboard(ctx.t, chat)})
}

export async function replyWithChat(ctx: BotContext, chat: Chat) {
  await ctx.reply(buildText(ctx.t, chat), {reply_markup: buildChatKeyboard(ctx.t, chat)})
}

function buildText(t: BotContext['t'], chat: Chat) {
  return t('chat', {
    title: chat.title,
    status: chat.status,
    price: chat.price,
    paymentType: chat.paymentType,
  })
}
