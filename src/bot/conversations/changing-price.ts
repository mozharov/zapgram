import {updateChat} from '../../models/chat.js'
import type {BotConversation, ConversationContext} from '../context.js'
import {waitForSats} from '../helpers/conversations/wait-for-sats.js'
import {replyWithChat} from '../helpers/messages/chat.js'

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
