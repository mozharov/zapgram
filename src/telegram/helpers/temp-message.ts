import {sleep} from '@core/utils/sleep.js'
import type {AppLogger} from '@infra/logger.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import type {Context} from 'grammy'
import {getRuntime} from '../../runtime.js'
import {deleteMessagesSafely} from './delete-message.js'

type ContextWithLog = Context & {log: AppLogger}

export async function replyWithTempMessage(
  ctx: ContextWithLog,
  text: string,
  options?: {
    delayMs?: number
    other?: Parameters<Context['reply']>[1]
  },
) {
  const message = await ctx.reply(text, options?.other)
  void sleep(options?.delayMs ?? getRuntime().config.TEMP_MESSAGE_DELAY_MS).then(() =>
    deleteMessagesSafely(ctx, [message.message_id]),
  )
}

/**
 * Show a hint or a closing confirmation inside a conversation, then remove both it and the user
 * message it answers after the configured delay. `conversation.external` schedules the timer once,
 * so replaying the conversation body does not create duplicate cleanups.
 *
 * Pass `keepInput` when the caller already disposes of the user message itself — `showLivingMenu`
 * deletes it right away, and listing an id that is gone by the time the timer fires would risk
 * taking the whole batch, hint included, down with it.
 */
export async function replyWithConversationTempMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  text: string,
  options?: {keepInput?: boolean},
): Promise<void> {
  const hint = await ctx.reply(text)
  const userMessageId = ctx.message?.from?.is_bot ? undefined : ctx.message?.message_id
  const inputMessageId = options?.keepInput ? undefined : userMessageId
  const messageIds = [inputMessageId, hint.message_id].filter(
    (messageId): messageId is number => messageId !== undefined,
  )

  await conversation.external(() => {
    const {bot, config} = getRuntime()
    void sleep(config.TEMP_MESSAGE_DELAY_MS).then(async () => {
      try {
        await bot.api.deleteMessages(hint.chat.id, messageIds)
      } catch (error) {
        ctx.log.warn({error, messageIds}, 'Failed to delete temporary conversation messages')
      }
    })
  })
}
