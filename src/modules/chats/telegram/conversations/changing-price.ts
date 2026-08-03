import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
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
  // Re-check ownership at write time: the entry handler already gated, but ownership can
  // transfer while the conversation is waiting for the amount.
  const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!owned) {
    await ctx.reply(ctx.t('chat.not-found'))
    return
  }
  const chat = await updateChat(chatId, {price: sats})
  await ctx.reply(ctx.t('changing-price.completed', {price: sats}))
  await replyWithChat(ctx, chat)
}
