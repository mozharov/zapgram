import {decodeInvoice} from '@core/lightning/decode-invoice.js'
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
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {InlineKeyboard} from 'grammy'

export async function waitForInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    host?: ConversationHost
    html?: string
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
) {
  const keyboard = new InlineKeyboard().add({
    callback_data: staticCallback.cancel,
    text: ctx.t('button.cancel'),
  })
  const html = opts?.html ?? ctx.t('wait-for-invoice')
  const message = await showHostOrReply(ctx, html, keyboard, opts?.host)
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-invoice'),
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

    const invoice = /(lnbc[a-z0-9]+)/.exec(next.message?.text ?? '')?.[1]
    if (!invoice) {
      await replyWithConversationTempMessage(conversation, next, next.t('wait-for-invoice.invalid'))
      continue
    }

    try {
      decodeInvoice(invoice)
    } catch {
      await replyWithConversationTempMessage(conversation, next, next.t('wait-for-invoice.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    await deleteMessageSafely(next)
    return invoice
  }
}
