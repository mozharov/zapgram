import type {Context} from 'grammy'

/**
 * Telegram's official "Group Anonymous Bot" — the fake `from` on anonymous admin messages.
 * Also has `is_bot: true`; the id is kept for explicit checks and tests.
 */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824

/**
 * True when the update is from a real human account we can debit / reply to privately.
 *
 * Rejects bots, the Group Anonymous Bot, and any message sent on behalf of a chat
 * (`sender_chat`: anonymous group admin, send-as channel, linked channel post in discussion).
 * Bot API never reveals the real user behind those identities.
 */
export function isIdentifiableHumanSender(ctx: Context): boolean {
  const from = ctx.from
  if (!from || from.is_bot || from.id === GROUP_ANONYMOUS_BOT_ID) return false
  if (messageSenderChat(ctx) !== undefined) return false
  return true
}

/** User id for Telegram ephemeral delivery, or undefined when only a public temp reply works. */
export function ephemeralReceiverUserId(ctx: Context): number | undefined {
  if (!isIdentifiableHumanSender(ctx)) return undefined
  return ctx.from?.id
}

function messageSenderChat(ctx: Context) {
  const msg = ctx.msg
  if (!msg || !('sender_chat' in msg)) return undefined
  return msg.sender_chat
}
