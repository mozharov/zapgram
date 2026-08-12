import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'

type ContextWithLog = Context & {log: AppLogger}

/**
 * Best-effort delete of the message that triggered the update.
 *
 * Telegram often refuses: message too old ("can't be deleted for everyone"), already gone,
 * missing delete rights, etc. Callers use this for UI cleanup (callback boards, /tip noise);
 * failure must not abort the real work or surface as an unknown bot error in PostHog.
 *
 * An ephemeral command (`is_ephemeral` in setMyCommands) is visible only to its sender. Telegram
 * addresses it by `ephemeral_message_id` (the update's `message_id` is 0), so we delete it with
 * `deleteEphemeralMessage` instead of `deleteMessage`.
 */
export async function deleteMessageSafely(ctx: ContextWithLog): Promise<void> {
  const msg = ctx.msg
  if (msg && msg.ephemeral_message_id !== undefined) {
    const receiverUserId = msg.receiver_user?.id ?? ctx.from?.id
    const chatId = ctx.chat?.id ?? msg.chat.id
    const ephemeralId = msg.ephemeral_message_id
    if (receiverUserId === undefined || chatId === undefined) return
    await ctx.api
      .deleteEphemeralMessage(chatId, receiverUserId, ephemeralId)
      .catch((error: unknown) => {
        ctx.log.warn({error}, 'Failed to delete message')
      })
    return
  }
  await ctx.deleteMessage().catch((error: unknown) => {
    ctx.log.warn({error}, 'Failed to delete message')
  })
}

/**
 * Best-effort bulk delete (e.g. temp group notices). Same rationale as deleteMessageSafely.
 */
export async function deleteMessagesSafely(
  ctx: ContextWithLog,
  messageIds: number[],
): Promise<void> {
  if (messageIds.length === 0) return
  await ctx.deleteMessages(messageIds).catch((error: unknown) => {
    ctx.log.warn({error, messageIds}, 'Failed to delete messages')
  })
}
