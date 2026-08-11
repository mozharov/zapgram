import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
} from '@telegram/helpers/conversation-prompt.js'
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
): Promise<MemoTextResult> {
  const html = ctx.t('wait-for-memo')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard().row({
      callback_data: staticCallback.cancel,
      text: ctx.t('button.cancel'),
    }),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-invoice-memo'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return {status: 'cancelled', reason: 'cancel'}
    }
    if (kind === 'interrupt') {
      await deactivatePrompt(conversation, prompt, cancelled)
      return {status: 'interrupted', reason: 'interrupt'}
    }

    const memo = next.message?.text?.trim()
    if (!memo || memo.length > MAX_MEMO_LENGTH) {
      await next.reply(next.t('wait-for-memo.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return {status: 'ok', memo}
  }
}
