import type {Chat} from '../../../lib/database/types.js'
import type {BotContext} from '../../context.js'
import {buildChatKeyboard} from '../keyboards/chat.js'

export async function editMessageWithChat(ctx: BotContext, chat: Chat) {
  await ctx.editMessageText(
    ctx.t('chat', {
      title: chat.title,
      username: chat.username ?? 'no',
      status: chat.status,
      price: chat.price,
      paymentType: chat.paymentType,
    }),
    {reply_markup: buildChatKeyboard(ctx.t, chat)},
  )
}
