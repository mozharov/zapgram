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
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
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
): Promise<{host: ConversationHost; nonce: number}> {
  // Stable for replays of this attempt, new after cancel and a new send.
  // The amount and the recipient are not in the payload.
  const nonce = await conversation.now()
  const confirmData = `${CONFIRM_SEND}:${nonce}`
  const keyboard = new InlineKeyboard()
    .text(ctx.t('button.confirm-send'), confirmData)
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
    const data = next.callbackQuery?.data
    if (
      typeof data === 'string' &&
      (data === CONFIRM_SEND || data.startsWith(`${CONFIRM_SEND}:`))
    ) {
      const sameScreen =
        isCallbackFromPrompt(next, prompt) && next.callbackQuery?.message?.chat.id === prompt.chatId
      if (sameScreen && data === confirmData) {
        await next.answerCallbackQuery()
        await clearPromptControls(conversation, prompt)
        return {host: confirmHost, nonce}
      }
      // Old attempt, or a confirm button whose message belongs to another chat.
      await next.answerCallbackQuery({text: next.t('callback-answer.confirm-stale')})
      continue
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (opts.onCancel) await opts.onCancel(opts.host ?? confirmHost)
      else await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    // A stray message is not a cancel. The amount step keeps waiting the same way.
    await replyWithConversationTempMessage(conversation, next, next.t('sending-to-user.use-button'))
  }
}
