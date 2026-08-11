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

export async function waitForInvoice(conversation: BotConversation, ctx: ConversationContext) {
  const keyboard = new InlineKeyboard().add({
    callback_data: staticCallback.cancel,
    text: ctx.t('button.cancel'),
  })
  const html = ctx.t('wait-for-invoice')
  const message = await ctx.reply(html, {reply_markup: keyboard})
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
      await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    const invoice = /(lnbc[a-z0-9]+)/.exec(next.message?.text ?? '')?.[1]
    if (!invoice) {
      await next.reply(next.t('wait-for-invoice.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return invoice
  }
}
