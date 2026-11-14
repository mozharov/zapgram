import {looksLikeOnchainAddress} from '@core/onchain/looks-like-address.js'
import {classifyTextKind, type TextKind} from '@telegram/text-kind.js'

/**
 * Cap for the `text` property on `dm_unrecognized_text`.
 * PostHog rejects a capture around 1MB; 4000 Unicode code points stay far under that.
 * The cut is by code point, so a surrogate pair is never split.
 */
export const UNRECOGNIZED_TEXT_CODE_POINT_LIMIT = 4000

export type UnrecognizedTextProperties = {
  text_length: number
  looks_like_onchain: boolean
  text_kind: TextKind
  /** Original message, or the first 4000 code points when `text_truncated`. */
  text: string
  text_truncated: boolean
}

/**
 * Properties for `dm_unrecognized_text`. `text` is the original string with no trim,
 * case fold, hash, or redaction. Only a message past the code-point cap is shortened,
 * and `text_length` stays the JavaScript length of the original.
 */
export function dmUnrecognizedTextProperties(text: string): UnrecognizedTextProperties {
  const clipped = clipToCodePoints(text, UNRECOGNIZED_TEXT_CODE_POINT_LIMIT)
  return {
    text_length: text.length,
    looks_like_onchain: looksLikeOnchainAddress(text),
    text_kind: classifyTextKind(text),
    text: clipped.text,
    text_truncated: clipped.truncated,
  }
}

function clipToCodePoints(text: string, limit: number): {text: string; truncated: boolean} {
  let codePoints = 0
  let units = 0
  for (const char of text) {
    if (codePoints === limit) return {text: text.slice(0, units), truncated: true}
    codePoints += 1
    units += char.length
  }
  return {text, truncated: false}
}
