import type {AppLogger} from '@infra/logger.js'
import {isBotNotAdminError} from '@telegram/errors/bot-not-admin.js'
import type {Context} from 'grammy'
import {getRuntime} from '../../runtime.js'
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
 * timer). The same temp path is used when Telegram refuses the ephemeral send — notably with
 * BOT_NOT_ADMIN: ephemeral messages need admin rights, a plain reply does not. The fallback replies
 * to the triggering message when it has a real id, so the sender still sees it's meant for them.
 *
 * Never throws: returns `false` when nothing could be delivered, so the caller can try another
 * channel (e.g. a private message) instead of the failure bubbling up as an unknown bot error.
 */
export async function replyOnlyToSender(
  ctx: ContextWithLog,
  text: string,
  options?: Parameters<typeof replyWithTempMessage>[2],
): Promise<boolean> {
  const receiverUserId = ephemeralReceiverUserId(ctx)
  if (receiverUserId !== undefined) {
    const sent = await ctx
      .reply(text, {...options?.other, receiver_user_id: receiverUserId})
      .catch((error: unknown) => {
        if (isBotNotAdminError(error)) {
          ctx.log.info({receiverUserId}, 'Ephemeral message needs admin rights, replying publicly')
        } else ctx.log.warn({error, receiverUserId}, 'Failed to send ephemeral message')
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
      return true
    }
  }
  return replyWithTempMessage(ctx, text, withReplyToTrigger(ctx, options)).then(
    () => true,
    (error: unknown) => {
      ctx.log.warn({error}, 'Failed to send group notice')
      return false
    },
  )
}

/** Thread the public fallback under the command; ephemeral input (message_id 0) has no anchor. */
function withReplyToTrigger(
  ctx: Context,
  options?: Parameters<typeof replyWithTempMessage>[2],
): Parameters<typeof replyWithTempMessage>[2] {
  const msg = ctx.message
  if (!msg?.message_id || msg.ephemeral_message_id !== undefined) return options
  if (options?.other?.reply_parameters) return options
  return {
    ...options,
    other: {
      ...options?.other,
      reply_parameters: {message_id: msg.message_id, allow_sending_without_reply: true},
    },
  }
}

/**
 * `replyOnlyToSender` for handlers with i18n: when the group refuses every reply, the sender gets
 * the notice in a private chat instead, with a hint that the bot needs to be a group admin.
 */
export async function replyOnlyToSenderOrDm(
  ctx: ContextWithLog & {t: (key: string) => string},
  text: string,
): Promise<void> {
  if (await replyOnlyToSender(ctx, text)) return
  const userId = ephemeralReceiverUserId(ctx)
  if (userId === undefined) return
  const sent = await getRuntime().notifier.send(
    userId,
    `${text}\n\n${ctx.t('error.bot-not-admin')}`,
    undefined,
    {transient: true},
  )
  if (!sent) ctx.log.warn('Failed to deliver group notice in private chat')
}
