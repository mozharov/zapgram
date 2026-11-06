/** Text from a recipient, safe to place inside a Telegram HTML message. */
export function escapeTelegramHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Who the confirmation is paying. A spec LNURL invoice often has only a description
 * hash, so the BOLT11 description is empty. The metadata's plain text and identifier
 * are the name the user has to see before confirming.
 */
export function lnurlPayeeHtml(description: string, identifier: string): string | undefined {
  const payee = escapeTelegramHtml(description.trim())
  const id = escapeTelegramHtml(identifier.trim())
  if (payee && id) return `<b>${payee}</b> <code>${id}</code>`
  if (payee) return `<b>${payee}</b>`
  if (id) return `<code>${id}</code>`
  return undefined
}
