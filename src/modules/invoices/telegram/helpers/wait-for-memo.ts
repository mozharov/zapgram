import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  editHostCaption,
  showHostOrReply,
} from '@telegram/helpers/conversation-host.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {InlineKeyboard} from 'grammy'

const MAX_MEMO_LENGTH = 150

export type MemoTextResult =
  | {status: 'ok'; memo: string}
  | {status: 'cancelled'; reason: 'cancel'}
  | {status: 'interrupted'; reason: 'interrupt'}

/**
 * Prompt for invoice memo text (after the user opted in via Add memo).
 */
export async function waitForMemoText(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    host?: ConversationHost
    html?: string
    kind?: 'text' | 'caption'
  },
): Promise<MemoTextResult> {
  const html = opts?.html ?? ctx.t('wait-for-memo')
  const keyboard = new InlineKeyboard().row({
    callback_data: staticCallback.cancel,
    text: ctx.t('button.cancel'),
  })
  const message =
    opts?.host && opts.kind === 'caption'
      ? await editHostCaption(ctx, opts.host, html, keyboard)
      : await showHostOrReply(ctx, html, keyboard, opts?.host)
  const prompt = createActivePrompt(message, {
    kind: opts?.kind === 'caption' ? 'caption' : 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-invoice-memo'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (!opts?.host) await deactivatePrompt(conversation, prompt, cancelled)
      return {status: 'cancelled', reason: 'cancel'}
    }
    if (kind === 'interrupt') {
      // Same guard as 'cancel': a persistent host (the invoice) stays live and is re-rendered by
      // the caller, so it must not be annotated with the generic "Action canceled." text here.
      if (!opts?.host) await deactivatePrompt(conversation, prompt, cancelled)
      return {status: 'interrupted', reason: 'interrupt'}
    }

    const memo = next.message?.text?.trim()
    if (!memo || memo.length > MAX_MEMO_LENGTH) {
      await replyWithConversationTempMessage(conversation, next, next.t('wait-for-memo.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return {status: 'ok', memo}
  }
}
