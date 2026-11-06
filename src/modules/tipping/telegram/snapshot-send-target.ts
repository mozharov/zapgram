import {classifySendTarget, type SendTarget} from '@core/lightning/send-target.js'
import {getUserByUsername} from '@modules/users/repository.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {getRuntime} from '../../../runtime.js'

/** Plain identity. Dates and wallet rows are not stored in the conversation checkpoint. */
export type SnapshottedSendTarget =
  | Exclude<SendTarget<{id: number; username: string | null}>, {kind: 'user'}>
  | {kind: 'user'; userId: number; username: string}

/**
 * Resolve a send target once and replay that same result.
 *
 * `getUserByUsername` hits the database and `bot.api.getChat` is outside the
 * conversation API log, so a later replay cannot pair a new row with an old
 * Telegram answer. The checkpoint stores only this snapshot.
 */
export function snapshotSendTarget(
  conversation: BotConversation,
  ctx: ConversationContext,
  text: string,
): Promise<SnapshottedSendTarget> {
  const selfUsername = ctx.user.username
  return conversation.external(async () => {
    const resolved = await classifySendTarget(text, {
      selfUsername,
      findUser: username => getUserByUsername(username),
      telegramUsername: async userId => {
        const chat = await getRuntime().bot.api.getChat(userId)
        return chat.username
      },
    })
    if (resolved.kind !== 'user') return resolved
    return {
      kind: 'user',
      userId: resolved.user.id,
      username: resolved.user.username ?? '',
    }
  })
}
