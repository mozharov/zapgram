/**
 * Timestamps must reach the user as Telegram `date_time` entities (Bot API 9.5), never as text we
 * formatted ourselves: the client renders them in the viewer's own timezone and locale, which is
 * the only way a bot can show local time at all — the Bot API exposes no user timezone.
 *
 * The tag body is what clients too old to know the entity display, so it stays a readable,
 * explicitly-UTC date instead of a placeholder.
 */
import type {MessageEntity} from 'grammy/types'

/**
 * Telegram's own `r|w?[dD]?[tT]?` grammar: `r` relative to now (cannot be combined), `w` localized
 * weekday, `d`/`D` short/long date, `t`/`T` short/long time. The empty format is dropped — it
 * leaves the text untouched, which is the behaviour the entity exists to avoid.
 */
export type TgTimeFormat = Exclude<MessageEntity.DateTimeMessageEntity['date_time_format'], ''>

/** Mirrors the grammar above; used to reject typos in the locale files. */
export const TG_TIME_FORMAT_PATTERN = /^(?:r|w?[dD]?[tT]?)$/

const DEFAULT_FORMAT: TgTimeFormat = 'Dt'

/**
 * The date the tag falls back to. Locale-free on purpose: a custom Fluent function has no access
 * to the message locale, and an ISO-shaped UTC stamp is unambiguous in both English and Russian.
 */
export function tgTimeFallbackText(epochMs: number, format: TgTimeFormat): string {
  const iso = new Date(epochMs).toISOString()
  const withTime = format === 'r' || /[tT]/.test(format)
  const withDate = format === 'r' || /[dD]/.test(format) || !withTime
  const parts: string[] = []
  if (withDate) parts.push(iso.slice(0, 10))
  if (withTime) parts.push(format.includes('T') ? iso.slice(11, 19) : iso.slice(11, 16))
  return withTime ? `${parts.join(' ')} UTC` : parts.join(' ')
}

/** Renders a `date_time` entity for the HTML parse mode. Returns '' for a non-date value. */
export function tgTime(epochMs: number, format: TgTimeFormat = DEFAULT_FORMAT): string {
  if (!Number.isFinite(epochMs)) return ''
  const unix = Math.floor(epochMs / 1000)
  const fallback = tgTimeFallbackText(epochMs, format)
  return `<tg-time unix="${unix}" format="${format}">${fallback}</tg-time>`
}

/**
 * `TGTIME($date, format: "Dt")` for the locale files. Fluent hands over already-resolved values,
 * so a `Date` variable arrives as a `FluentDateTime` wrapping epoch milliseconds.
 */
export function tgTimeFluentFunction(
  positional: ReadonlyArray<unknown>,
  named: Record<string, unknown>,
): string {
  const epochMs = toEpochMs(positional[0])
  if (epochMs === null) return ''
  return tgTime(epochMs, toFormat(named.format))
}

function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return (value as {value: unknown}).value
  }
  return value
}

function toEpochMs(value: unknown): number | null {
  const raw = unwrap(value)
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime()
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return null
}

function toFormat(value: unknown): TgTimeFormat {
  const raw = unwrap(value)
  if (typeof raw === 'string' && raw !== '' && TG_TIME_FORMAT_PATTERN.test(raw)) {
    return raw as TgTimeFormat
  }
  return DEFAULT_FORMAT
}
