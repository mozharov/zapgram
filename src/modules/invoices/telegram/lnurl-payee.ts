/** How much of a recipient's text we put on screen. The raw metadata is not trimmed. */
export const LNURL_DISPLAY_LIMIT = 240

/** Text from a recipient, safe to place inside a Telegram HTML message. */
export function escapeTelegramHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function clipLnurlDisplay(value: string, limit = LNURL_DISPLAY_LIMIT): string {
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1)}…`
}

export type LnurlPayeeView = {
  /** The address the user typed, or the host of the LNURL they pasted. */
  entered: string
  enteredKind: 'address' | 'host'
  /** Metadata hops, then callback hops. A redirect is more than one. */
  hosts: string[]
  /** Untrusted text/plain. Not an address and not the identifier. */
  serviceText: string
}

/**
 * Who this payment is going to, from what the user typed and the hosts we actually
 * connected to. Metadata identifier is not shown: the server chooses that string.
 */
export function lnurlPayeeParts(view: LnurlPayeeView): {
  entered: string
  route: string
  invoiceHost: string
  note: string
} {
  const hosts = view.hosts.filter(
    (host, index) => host.length > 0 && view.hosts.indexOf(host) === index,
  )
  return {
    entered: escapeTelegramHtml(clipLnurlDisplay(view.entered)),
    route:
      hosts.length > 1
        ? hosts
            .map(host => `<code>${escapeTelegramHtml(clipLnurlDisplay(host))}</code>`)
            .join(' → ')
        : '',
    invoiceHost: escapeTelegramHtml(clipLnurlDisplay(hosts.at(-1) ?? '')),
    note: escapeTelegramHtml(clipLnurlDisplay(view.serviceText)),
  }
}
