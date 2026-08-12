import type {AppLocale} from '@core/i18n/locale.js'
import {formatBroadcastConfirm, formatBroadcastStarted} from '@modules/broadcast/format.js'
import {
  buildBroadcastConfirmKeyboard,
  buildBroadcastLocaleKeyboard,
} from '@modules/broadcast/telegram/keyboards/broadcast.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {
  broadcastConfirmRoute,
  broadcastLocaleRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ActivePrompt,
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/**
 * Admin broadcast: pick locale → source message → confirm → snapshot + background job.
 */
export async function broadcasting(conversation: BotConversation, ctx: ConversationContext) {
  const locale = await waitForLocale(conversation, ctx)
  const source = await waitForSourceMessage(conversation, ctx)

  const {broadcastService} = getRuntime()
  const totalCount = await conversation.external(() =>
    broadcastService.countRecipients(locale, ctx.user.id),
  )

  const confirmHtml = formatBroadcastConfirm(locale, totalCount)
  const confirmMessage = await ctx.reply(confirmHtml, {
    reply_markup: buildBroadcastConfirmKeyboard(ctx.t),
  })
  const confirmPrompt = createActivePrompt(confirmMessage, {
    kind: 'text',
    html: confirmHtml,
    actionLabel: ctx.t('conversation-action.broadcast-confirm'),
  })

  await waitForConfirm(conversation, ctx, confirmPrompt)
  await clearPromptControls(conversation, confirmPrompt)

  const {broadcast, totalCount: n} = await conversation.external(() =>
    broadcastService.startBroadcast({
      adminUserId: ctx.user.id,
      locale,
      sourceChatId: source.chatId,
      sourceMessageId: source.messageId,
    }),
  )

  await ctx.reply(formatBroadcastStarted(locale, n))
  // Kick the queue without blocking the conversation (cron is backup).
  void conversation
    .external(() => broadcastService.processQueue())
    .catch(error => {
      getRuntime().log.error(
        {error, broadcastId: broadcast.id},
        'Immediate broadcast process failed',
      )
    })
}

async function waitForLocale(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<AppLocale> {
  const html = ctx.t('broadcast.pick-locale')
  const message = await ctx.reply(html, {
    reply_markup: buildBroadcastLocaleKeyboard(ctx.t),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.broadcast-locale'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const data = next.callbackQuery?.data

    if (data === staticCallback.cancel && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithWallet(ctx)
      return conversation.halt()
    }

    if (data && broadcastLocaleRoute.pattern.test(data) && isCallbackFromPrompt(next, prompt)) {
      const {locale} = broadcastLocaleRoute.parse(data)
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, prompt)
      return locale
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)
    await next.reply(next.t('conversation-state.use-buttons'))
  }
}

async function waitForSourceMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<{chatId: number; messageId: number}> {
  const html = ctx.t('broadcast.send-message')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.broadcast-source'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithWallet(ctx)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const source = next.message
    if (!source || !next.chat) {
      await next.reply(next.t('broadcast.invalid-message'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return {chatId: next.chat.id, messageId: source.message_id}
  }
}

async function waitForConfirm(
  conversation: BotConversation,
  ctx: ConversationContext,
  prompt: ActivePrompt,
): Promise<void> {
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const data = next.callbackQuery?.data

    if (data && broadcastConfirmRoute.pattern.test(data) && isCallbackFromPrompt(next, prompt)) {
      const {action} = broadcastConfirmRoute.parse(data)
      await next.answerCallbackQuery()
      if (action === 'yes') return
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithWallet(ctx)
      return conversation.halt()
    }

    if (data === staticCallback.cancel && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithWallet(ctx)
      return conversation.halt()
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)
    await next.reply(next.t('conversation-state.use-buttons'))
  }
}
