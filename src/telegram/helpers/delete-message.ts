import {sleep} from '@core/utils/sleep.js'
import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {getRuntime} from '../../runtime.js'

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
 * `deleteEphemeralMessage` instead of `deleteMessage`. grammY's own docs note that delivery of an
 * ephemeral delete "is not guaranteed... especially if [the recipient is] offline", so a second
 * attempt is scheduled after the temp-message delay to catch senders who reconnect later.
 */
export async function deleteMessageSafely(
  ctx: ContextWithLog,
  options?: {delayMs?: number},
): Promise<void> {
  const msg = ctx.msg
  if (msg && msg.ephemeral_message_id !== undefined) {
    const receiverUserId = msg.receiver_user?.id ?? ctx.from?.id
    const chatId = ctx.chat?.id ?? msg.chat.id
    const ephemeralId = msg.ephemeral_message_id
    if (receiverUserId === undefined || chatId === undefined) return
    await deleteEphemeralMessageOnce(ctx, chatId, receiverUserId, ephemeralId)
    scheduleEphemeralMessageDelete(ctx, chatId, receiverUserId, ephemeralId, options?.delayMs)
    return
  }
  await ctx.deleteMessage().catch((error: unknown) => {
    ctx.log.warn({error}, 'Failed to delete message')
  })
}

async function deleteEphemeralMessageOnce(
  ctx: ContextWithLog,
  chatId: number,
  receiverUserId: number,
  ephemeralId: number,
): Promise<void> {
  await ctx.api
    .deleteEphemeralMessage(chatId, receiverUserId, ephemeralId)
    .catch((error: unknown) => {
      ctx.log.warn({error}, 'Failed to delete message')
    })
}

/**
 * Schedule a delete of an ephemeral message after the temp-message delay. Used both as the retry
 * behind `deleteMessageSafely`'s immediate attempt and, from `replyOnlyToSender`, as the only
 * delete for a group error notice that must stay readable for a while before it disappears.
 */
export function scheduleEphemeralMessageDelete(
  ctx: ContextWithLog,
  chatId: number,
  receiverUserId: number,
  ephemeralId: number,
  delayMs?: number,
): void {
  void sleep(delayMs ?? getRuntime().config.TEMP_MESSAGE_DELAY_MS).then(() =>
    deleteEphemeralMessageOnce(ctx, chatId, receiverUserId, ephemeralId),
  )
}

/**
 * Schedule a best-effort delete of a plain message after the temp-message delay. Used for the input
 * a failure answers: the error notice itself is transient — the next notification or menu removes
 * it — so the message that caused it must not be left behind on its own.
 */
export function scheduleMessageDelete(
  ctx: ContextWithLog,
  messageId: number,
  delayMs?: number,
): void {
  void sleep(delayMs ?? getRuntime().config.TEMP_MESSAGE_DELAY_MS).then(() =>
    deleteMessagesSafely(ctx, [messageId]),
  )
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
