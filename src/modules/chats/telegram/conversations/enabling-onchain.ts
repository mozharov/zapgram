import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import type {EnableOnchainResult} from '@modules/onchain/enable.service.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function enablingOnchain(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  const prompt = await ctx.reply(ctx.t('enabling-onchain'), {
    reply_markup: new InlineKeyboard().text(ctx.t('button.cancel'), 'cancel'),
  })

  while (true) {
    const next = await conversation.waitFor(['message:text', 'callback_query:data'])

    if (next.callbackQuery?.data === 'cancel') {
      await next.answerCallbackQuery()
      await next.editMessageText(ctx.t('canceled'))
      const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
      if (owned) await replyWithChat(ctx, owned)
      return
    }

    const masterpub = next.message?.text?.trim()
    if (!masterpub) {
      await ctx.reply(ctx.t('enabling-onchain.invalid'))
      continue
    }

    const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
    if (!owned) {
      await conversation.external(() => removeInlineKeyboard(prompt))
      await ctx.reply(ctx.t('chat.not-found'))
      return
    }

    const {onchainEnableService, posthog} = getRuntime()
    const result = await onchainEnableService.enable(owned, masterpub)

    if (result.status === 'invalid_masterpub' || result.status === 'watchonly_error') {
      // Keep the original prompt + Cancel; user can paste another key or cancel.
      await ctx.reply(errorText(ctx, result))
      continue
    }

    await conversation.external(() => removeInlineKeyboard(prompt))

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
    return
  }
}

function errorText(
  ctx: ConversationContext,
  result: Extract<EnableOnchainResult, {status: 'invalid_masterpub' | 'watchonly_error'}>,
): string {
  if (result.status === 'invalid_masterpub') {
    return ctx.t('enabling-onchain.invalid')
  }
  // Reasons come from LNbits `{detail}` via classifyWatchOnlyError.
  if (result.reason === 'nonstandard_depth') return ctx.t('enabling-onchain.nonstandard-depth')
  if (result.reason === 'network_mismatch') return ctx.t('enabling-onchain.network-mismatch')
  return ctx.t('enabling-onchain.failed')
}
