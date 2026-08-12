import {ToYourselfError} from '@core/errors/to-yourself.js'
import {UserDoesNotHaveWalletError} from '@core/errors/user-does-not-have-wallet.js'
import {getUserByUsername} from '@modules/users/repository.js'
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
import {InlineKeyboard} from 'grammy'

const USERNAME_REGEX = /^@([a-zA-Z0-9_]+)$/

export async function waitForUser(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    host?: ConversationHost
    html?: string
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

    const matched = USERNAME_REGEX.exec(next.message?.text?.trim() ?? '')?.[1]
    if (!matched) {
      await next.reply(next.t('wait-for-user.invalid'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return validateUsername(next, matched.toLowerCase())
  }
}

async function validateUsername(ctx: ConversationContext, username: string) {
  if (username === ctx.user.username) throw new ToYourselfError()
  const user = await getUserByUsername(username)
  if (!user) throw new UserDoesNotHaveWalletError()
  const tgUser = await ctx.api.getChat(user.id)
  if (tgUser.username?.toLowerCase() !== username) throw new UserDoesNotHaveWalletError()
  return user
}
