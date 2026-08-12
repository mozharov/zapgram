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

const MAX_AMOUNT = 100000000

export async function waitForSats(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {onCancel?: () => Promise<unknown>},
) {
  const html = ctx.t('wait-for-sats')
  const message = await replyWithWaitForSats(ctx, html)
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
      await deactivatePrompt(conversation, prompt, cancelled)
      await opts?.onCancel?.()
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
    return sats
  }
}

function replyWithWaitForSats(ctx: ConversationContext, html: string) {
  return ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
}
