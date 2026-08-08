import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function enablingOnchain(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  await ctx.reply(ctx.t('enabling-onchain'), {
    reply_markup: new InlineKeyboard().text(ctx.t('button.cancel'), 'cancel'),
  })

  const masterpub = await waitForMasterpub(conversation, ctx)
  if (masterpub === undefined) return

  const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!owned) {
    await ctx.reply(ctx.t('chat.not-found'))
    return
  }

  const {onchainEnableService, posthog} = getRuntime()
  const result = await onchainEnableService.enable(owned, masterpub)

  if (result.status === 'invalid_masterpub') {
    await ctx.reply(ctx.t('enabling-onchain.invalid'))
    return
  }
  if (result.status === 'watchonly_error') {
    await ctx.reply(ctx.t('enabling-onchain.failed'))
    return
  }

  if (posthog) setTelegramChatGroup(posthog, result.chat, String(ctx.user.id))
  captureBotEvent(
    posthog,
    'chat_onchain_enabled',
    {
      chat_title: result.chat.title,
      fingerprint: result.fingerprint,
    },
    {chatId},
  )

  await ctx.reply(
    ctx.t('enabling-onchain.completed', {
      fingerprint: result.fingerprint,
    }),
  )
  await replyWithChat(ctx, result.chat)
}

async function waitForMasterpub(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<string | undefined> {
  const next = await conversation.waitFor(['message:text', 'callback_query:data'])
  if (next.callbackQuery?.data === 'cancel') {
    await next.answerCallbackQuery()
    await next.editMessageText(ctx.t('canceled'))
    return undefined
  }
  const text = next.message?.text?.trim()
  if (!text) {
    await ctx.reply(ctx.t('enabling-onchain.invalid'))
    return waitForMasterpub(conversation, ctx)
  }
  return text
}
