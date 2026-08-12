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
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {InlineKeyboard} from 'grammy'

const MAX_AMOUNT = 100000000

export async function waitForSats(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    host?: ConversationHost
    html?: string
    deleteInput?: boolean
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
) {
  const html = opts?.html ?? ctx.t('wait-for-sats')
  const message = await showHostOrReply(ctx, html, cancelKeyboard(ctx), opts?.host)
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-sats'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (opts?.host) await opts.onCancel?.(opts.host)
      else {
        await deactivatePrompt(conversation, prompt, cancelled)
        await opts?.onCancel?.({chatId: prompt.chatId, messageId: prompt.messageId})
      }
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    const text = next.message?.text?.trim()
    const sats = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(sats) || sats <= 0 || sats > MAX_AMOUNT) {
      await next.reply(next.t('wait-for-sats.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    if (opts?.deleteInput) await deleteMessageSafely(next)
    return sats
  }
}

function cancelKeyboard(ctx: ConversationContext) {
  return new InlineKeyboard([
    [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
  ])
}
