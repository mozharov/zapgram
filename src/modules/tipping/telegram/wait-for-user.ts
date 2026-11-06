import {snapshotSendTarget} from '@modules/tipping/telegram/snapshot-send-target.js'
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
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {InlineKeyboard} from 'grammy'

export async function waitForUser(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    host?: ConversationHost
    html?: string
    deleteInput?: boolean
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
) {
  const html = opts?.html ?? ctx.t('wait-for-user')
  const message = await showHostOrReply(
    ctx,
    html,
    new InlineKeyboard([[{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}]]),
    opts?.host,
  )
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.select-recipient'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await waitForStepInput(conversation, prompt, {intercept: 'all'})
    if (!next) continue
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

    const result = await snapshotSendTarget(conversation, next, next.message?.text ?? '')
    if (result.kind !== 'user') {
      const key =
        result.kind === 'self'
          ? 'error.to-yourself'
          : result.kind === 'unknown'
            ? 'error.user-does-not-have-wallet'
            : 'wait-for-user.invalid'
      await replyWithConversationTempMessage(conversation, next, next.t(key))
      continue
    }

    await clearPromptControls(conversation, prompt)
    // The report echoes the selected username, so the typed @handle itself is noise.
    if (opts?.deleteInput) await deleteMessageSafely(next)
    return {id: result.userId, username: result.username}
  }
}
