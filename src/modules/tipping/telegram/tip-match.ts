/** Sats sent when the trigger carries no amount. */
export const DEFAULT_TIP_SATS = 21

export type TipRequest = {sats: number; username?: string}

/**
 * The group tip trigger, matched against the real bot username instead of a baked-in one.
 *
 * Accepted: `/tip`, `/tip@thisbot` — Telegram clients append the bot username as soon as a chat
 * holds more than one bot — and a bare `@thisbot` mention, each followed by an optional amount and
 * recipient handle.
 *
 * - `null`: not addressed to this bot. `/tip@other_bot` belongs to that bot, so we stay silent.
 * - `'invalid'`: addressed to this bot, but the arguments do not parse (usage hint).
 */
export function matchTipRequest(
  text: string,
  botUsername: string | undefined,
): TipRequest | 'invalid' | null {
  const args = tipArguments(text, botUsername?.toLowerCase())
  if (args === null) return null

  const parsed = /^(?: (\d+))?(?: @(\w+))?$/.exec(args)
  if (!parsed) return 'invalid'
  const [, amount, username] = parsed
  return {sats: amount ? Number(amount) : DEFAULT_TIP_SATS, username: username?.toLowerCase()}
}

/** Everything the sender typed after the trigger, or `null` when the text is not for this bot. */
function tipArguments(text: string, botUsername: string | undefined): string | null {
  if (text.startsWith('/tip')) {
    const rest = text.slice('/tip'.length)
    const addressee = /^@(\w+)/.exec(rest)
    if (!addressee) return rest
    return addressee[1]?.toLowerCase() === botUsername ? rest.slice(addressee[0].length) : null
  }

  const mention = /^@(\w+)/.exec(text)
  if (mention && mention[1]?.toLowerCase() === botUsername) return text.slice(mention[0].length)
  return null
}
