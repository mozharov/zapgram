import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'

export async function changingPrice(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  await ctx.reply(ctx.t('changing-price'))
  const sats = await waitForSats(conversation, ctx, {
    onCancel: async () => {
      const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
      if (owned) await replyWithChat(ctx, owned)
      else await replyWithWallet(ctx)
    },
  })
  // Re-check ownership at write time: the entry handler already gated, but ownership can
  // transfer while the conversation is waiting for the amount.
  const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!owned) {
    await ctx.reply(ctx.t('chat.not-found'))
    return
  }
  const chat = await updateChat(chatId, {price: sats})
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, chat, String(ctx.user.id))
  captureBotEvent(
    posthog,
    'chat_price_updated',
    {price_sats: sats, chat_title: chat.title, payment_type: chat.paymentType},
    {chatId},
  )
  await ctx.reply(
    ctx.t('changing-price.completed', {
      price: sats,
      usdSuffix: await conversation.external(() => usdSuffixForSats(sats)),
    }),
  )
  await replyWithChat(ctx, chat)
}
