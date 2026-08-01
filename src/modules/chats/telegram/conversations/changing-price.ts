import {updateChat} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'

export async function changingPrice(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  await ctx.reply(ctx.t('changing-price'))
  const sats = await waitForSats(conversation, ctx)
  const chat = await updateChat(chatId, {price: sats})
  await ctx.reply(ctx.t('changing-price.completed', {price: sats}))
  await replyWithChat(ctx, chat)
}
