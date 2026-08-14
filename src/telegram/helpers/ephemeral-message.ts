import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {scheduleEphemeralMessageDelete} from './delete-message.js'
import {ephemeralReceiverUserId} from './identifiable-sender.js'
import {replyWithTempMessage} from './temp-message.js'

type ContextWithLog = Context & {log: AppLogger}

/**
 * Group notice that only the member who triggered the update can see.
 *
 * Telegram ephemeral messages (`receiver_user_id`) are the primary path: the rest of the group
 * never sees the notice. Delivery of the deletion event isn't guaranteed while the recipient is
 * offline, so rather than trust it to expire on its own, a delete is scheduled after the
 * temp-message delay — the same window a public temp message stays up for. Only successful money
 * movements deserve a public message in a group; failures and usage hints go through here.
 *
 * Anonymous admins, send-as channel, and other non-identifiable senders have no deliverable user
 * id — skip the ephemeral attempt and fall back to a public temp message (auto-deleted on a
 * timer). The same temp path is used when Telegram refuses the ephemeral send.
 */
export async function replyOnlyToSender(
  ctx: ContextWithLog,
  text: string,
  options?: Parameters<typeof replyWithTempMessage>[2],
): Promise<void> {
  const receiverUserId = ephemeralReceiverUserId(ctx)
  if (receiverUserId !== undefined) {
    const sent = await ctx
      .reply(text, {...options?.other, receiver_user_id: receiverUserId})
      .catch((error: unknown) => {
        ctx.log.warn({error, receiverUserId}, 'Failed to send ephemeral message')
        return undefined
      })
    if (sent) {
      if (sent.ephemeral_message_id !== undefined) {
        scheduleEphemeralMessageDelete(
          ctx,
          sent.chat.id,
          receiverUserId,
          sent.ephemeral_message_id,
          options?.delayMs,
        )
      }
      return
    }
  }
  await replyWithTempMessage(ctx, text, options)
}
