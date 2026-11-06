/** How much of a recipient's text we put on screen. The raw metadata is not trimmed. */
export const LNURL_DISPLAY_LIMIT = 240

/** Text from a recipient, safe to place inside a Telegram HTML message. */
export function escapeTelegramHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Bidi isolates and overrides. Left in a note, they can redraw "Invoice from …" over the route. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/** One line, no bidi controls. The note stays a note and cannot impersonate the route. */
export function flattenServiceText(value: string): string {
  return value.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim()
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
  // Consecutive repeats are one hop: the metadata fetch and the callback are
  // usually the same host, and that is not a redirect. A later return to an
  // earlier host stays, so A → B → A is still the route and A is the invoice.
  const hosts: string[] = []
  for (const host of view.hosts) {
    if (host.length === 0 || hosts.at(-1) === host) continue
    hosts.push(host)
  }
  return {
    entered: escapeTelegramHtml(clipLnurlDisplay(view.entered)),
    route:
      hosts.length > 1
        ? hosts
            .map(host => `<code>${escapeTelegramHtml(clipLnurlDisplay(host))}</code>`)
            .join(' → ')
        : '',
    invoiceHost: escapeTelegramHtml(clipLnurlDisplay(hosts.at(-1) ?? '')),
    note: escapeTelegramHtml(clipLnurlDisplay(flattenServiceText(view.serviceText))),
  }
}
