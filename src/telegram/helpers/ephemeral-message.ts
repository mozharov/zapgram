import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {replyWithTempMessage} from './temp-message.js'

type ContextWithLog = Context & {log: AppLogger}

/**
 * Group notice that only the member who triggered the update can see.
 *
 * Telegram ephemeral messages (`receiver_user_id`) are the primary path: the rest of the group
 * never sees the notice and Telegram expires it on its own, so nothing has to be deleted later.
 * Only successful money movements deserve a public message in a group; failures and usage hints go
 * through here.
 *
 * Telegram has no user to deliver to when the update comes from an anonymous admin or a channel
 * post, so the public temp message stays as the fallback for a refused send.
 */
export async function replyOnlyToSender(
  ctx: ContextWithLog,
  text: string,
  options?: Parameters<typeof replyWithTempMessage>[2],
): Promise<void> {
  const receiverUserId = ctx.from?.id
  if (receiverUserId !== undefined) {
    const sent = await ctx
      .reply(text, {...options?.other, receiver_user_id: receiverUserId})
      .then(() => true)
      .catch((error: unknown) => {
        ctx.log.warn({error, receiverUserId}, 'Failed to send ephemeral message')
        return false
      })
    if (sent) return
  }
  await replyWithTempMessage(ctx, text, options)
}
