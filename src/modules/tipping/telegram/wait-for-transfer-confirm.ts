import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {type ConversationHost, showHostOrReply} from '@telegram/helpers/conversation-host.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {InlineKeyboard} from 'grammy'

/** In-conversation only. Not a routed callback: a click after the wizard ends cannot pay. */
export const CONFIRM_SEND = 'confirm-send'

/**
 * Explicit debit confirmation. Returns only after the button on this message.
 * Cancel restores the caller’s screen and does not pay.
 */
export async function waitForTransferConfirm(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts: {
    host?: ConversationHost
    html: string
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
): Promise<ConversationHost> {
  const keyboard = new InlineKeyboard()
    .text(ctx.t('button.confirm-send'), CONFIRM_SEND)
    .row()
    .text(ctx.t('button.cancel'), staticCallback.cancel)
  const message = await showHostOrReply(ctx, opts.html, keyboard, opts.host)
  const confirmHost = {chatId: message.chat.id, messageId: message.message_id}
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html: opts.html,
    actionLabel: ctx.t('conversation-action.confirm-send'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await waitForStepInput(conversation, prompt, {intercept: 'all'})
    if (!next) continue
    if (next.callbackQuery?.data === CONFIRM_SEND && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, prompt)
      return confirmHost
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (opts.onCancel) await opts.onCancel(opts.host ?? confirmHost)
      else await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    if (opts.onCancel) await opts.onCancel(opts.host ?? confirmHost)
    else await deactivatePrompt(conversation, prompt, cancelled)
    if (next.message) await deleteMessageSafely(next)
    return conversation.halt()
  }
}
