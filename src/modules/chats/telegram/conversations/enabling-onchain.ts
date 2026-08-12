import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import type {EnableOnchainResult} from '@modules/onchain/enable.service.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function enablingOnchain(
  conversation: BotConversation,
  ctx: ConversationContext,
  chatId: number,
) {
  const html = ctx.t('enabling-onchain')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard().text(ctx.t('button.cancel'), staticCallback.cancel),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enable-onchain'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  while (true) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
      if (owned) await replyWithChat(ctx, owned)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    const masterpub = next.message?.text?.trim()
    if (!masterpub) {
      await next.reply(next.t('enabling-onchain.invalid'))
      continue
    }

    const owned = await getAccessibleChatForOwner(chatId, ctx.user.id)
    if (!owned) {
      await clearPromptControls(conversation, prompt)
      await next.reply(next.t('chat.not-found'))
      return
    }

    const {onchainEnableService, posthog} = getRuntime()
    const result = await onchainEnableService.enable(owned, masterpub)

    if (result.status === 'invalid_masterpub' || result.status === 'watchonly_error') {
      // Keep the original prompt + Cancel; user can paste another key or cancel.
      await ctx.reply(errorText(ctx, result))
      continue
    }

    await clearPromptControls(conversation, prompt)

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
