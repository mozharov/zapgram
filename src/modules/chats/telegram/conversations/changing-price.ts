import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {editHostWithChat, replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {ensureHost, joinWizardHtml} from '@telegram/helpers/conversation-host.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'

export async function changingPrice(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  const title = ctx.t('changing-price')
  const host = await ensureHost(ctx, title)
  const sats = await waitForSats(conversation, ctx, {
    host,
    html: joinWizardHtml(title, ctx.t('wait-for-sats')),
    onCancel: async () => {
      const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
      if (owned) await editHostWithChat(ctx, host, owned)
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
  ctx.log.info({chatId, price: sats, paymentType: chat.paymentType}, 'Chat price updated')
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, chat, String(ctx.user.id))
  captureBotEvent(
    posthog,
    'chat_price_updated',
    {price_sats: sats, chat_title: chat.title, payment_type: chat.paymentType},
    {chatId},
  )
  await ctx.api.editMessageText(
    host.chatId,
    host.messageId,
    ctx.t('changing-price.completed', {
      price: sats,
      usdSuffix: await conversation.external(() => usdSuffixForSats(sats)),
    }),
  )
  await replyWithChat(ctx, chat)
}
