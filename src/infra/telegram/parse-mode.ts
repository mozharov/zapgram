import type {Transformer} from 'grammy'

type ParseMode = 'HTML' | 'Markdown' | 'MarkdownV2'

/**
 * API transformer that sets a default parse_mode on outgoing Bot API calls
 * when the payload does not already specify one.
 */
export function parseMode(mode: ParseMode): Transformer {
  return (prev, method, payload, signal) => {
    if (!payload || 'parse_mode' in payload) {
      return prev(method, payload, signal)
    }

    // Rich messages define their own HTML/Markdown inside `rich_message`; Bot API methods that
    // carry this field do not accept the ordinary text `parse_mode` alongside it.
    if ('rich_message' in payload) return prev(method, payload, signal)

    switch (method) {
      case 'editMessageMedia': {
        if (
          'media' in payload &&
          payload.media &&
          typeof payload.media === 'object' &&
          !('parse_mode' in payload.media)
        ) {
          Object.assign(payload.media, {parse_mode: mode})
        }
        return prev(method, payload, signal)
      }
      case 'answerInlineQuery': {
        if ('results' in payload && Array.isArray(payload.results)) {
          for (const result of payload.results) {
            if (!result || typeof result !== 'object') continue
            if (
              'input_message_content' in result &&
              result.input_message_content &&
              typeof result.input_message_content === 'object' &&
              !('parse_mode' in result.input_message_content)
            ) {
              Object.assign(result.input_message_content, {parse_mode: mode})
            } else if (!('parse_mode' in result)) {
              Object.assign(result, {parse_mode: mode})
            }
          }
        }
        return prev(method, payload, signal)
      }
      // copy/forward have no text to parse; injecting parse_mode can 400 on Bot API.
      case 'copyMessage':
      case 'forwardMessage':
      case 'copyMessages':
      case 'forwardMessages':
        return prev(method, payload, signal)
      default:
        return prev(method, {...payload, parse_mode: mode}, signal)
    }
  }
}
