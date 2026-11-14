import {deflateSync} from 'node:zlib'
import {GrammyError} from 'grammy'
import type {InlineKeyboardMarkup} from 'grammy/types'

/**
 * Bot API 10.4 widget methods.
 *
 * grammY 1.45/1.46 types stop at Bot API 10.3, so these calls go through `api.raw`
 * (grammyjs/grammY#981). Replace this module with `api.sendWidget` / `api.editMessageWidgetData`
 * once that release ships — callers should not need to change.
 *
 * https://core.telegram.org/bots/api/methods/sendwidget.md
 * https://core.telegram.org/bots/api/methods/editmessagewidgetdata.md
 */

/** UTF-8 HTML before compression. */
export const WIDGET_HTML_MAX_BYTES = 32_768
/**
 * zlib level 9, the limit the Bot API enforces (Python `zlib.compress`).
 * Node's deflate can disagree by a few bytes, so we keep this much headroom.
 */
export const WIDGET_HTML_ZLIB_SLACK_BYTES = 48
/** zlib level 9, the limit the Bot API enforces. */
export const WIDGET_HTML_MAX_COMPRESSED_BYTES = 4096
/** `chat_data` and `public_data`, each, in UTF-8 bytes. */
export const WIDGET_DATA_MAX_BYTES = 1024

export class WidgetApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WidgetApiError'
  }
}

export type WidgetReplyMarkup = InlineKeyboardMarkup

export type SendWidgetParams = {
  chat_id: number | string
  html: string
  width?: number
  height?: number
  public_data?: string
  chat_data?: string
  caption?: string
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  caption_entities?: unknown[]
  show_caption_above_media?: boolean
  allow_queries?: boolean
  is_shared?: boolean
  disable_notification?: boolean
  protect_content?: boolean
  reply_markup?: WidgetReplyMarkup
}

export type EditMessageWidgetDataParams = {
  chat_id?: number | string
  message_id?: number
  inline_message_id?: string
  public_data?: string
  chat_data?: string
}

export type WidgetMessage = {
  message_id: number
  chat: {id: number | string}
}

type RawCaller = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

/**
 * Any grammY `Api`. `raw` is a proxy, so `sendWidget` exists at runtime before the types know it.
 */
export type WidgetRawApi = {
  raw: object
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Bytes after zlib level 9. This is what `sendWidget` counts against 4096. */
export function widgetHtmlCompressedBytes(html: string): number {
  return deflateSync(Buffer.from(html, 'utf8'), {level: 9}).length
}

export function assertWidgetHtml(html: string): void {
  const raw = utf8Bytes(html)
  if (raw < 1 || raw > WIDGET_HTML_MAX_BYTES) {
    throw new WidgetApiError(
      `Widget HTML must be 1–${WIDGET_HTML_MAX_BYTES} UTF-8 bytes (got ${raw})`,
    )
  }
  const compressed = widgetHtmlCompressedBytes(html)
  const limit = WIDGET_HTML_MAX_COMPRESSED_BYTES - WIDGET_HTML_ZLIB_SLACK_BYTES
  if (compressed > limit) {
    throw new WidgetApiError(
      `Widget HTML is ${compressed} bytes after zlib level 9; the limit is ${WIDGET_HTML_MAX_COMPRESSED_BYTES} (keeping ${WIDGET_HTML_ZLIB_SLACK_BYTES} bytes of slack)`,
    )
  }
}

export function assertWidgetData(
  field: 'chat_data' | 'public_data',
  value: string | undefined,
): void {
  if (value === undefined) return
  const bytes = utf8Bytes(value)
  if (bytes > WIDGET_DATA_MAX_BYTES) {
    throw new WidgetApiError(
      `${field} is ${bytes} UTF-8 bytes; the limit is ${WIDGET_DATA_MAX_BYTES}`,
    )
  }
}

export async function sendWidget(
  api: WidgetRawApi,
  params: SendWidgetParams,
  signal?: AbortSignal,
): Promise<WidgetMessage> {
  assertWidgetHtml(params.html)
  assertWidgetData('chat_data', params.chat_data)
  assertWidgetData('public_data', params.public_data)
  const result = await callRaw(api, 'sendWidget', {...params}, signal)
  if (!isWidgetMessage(result)) {
    throw new WidgetApiError('sendWidget did not return a message')
  }
  return result
}

/**
 * Edits widget state in place. `message is not modified` is success: the state was already
 * what we asked for, and Telegram counts a no-op edit as an error.
 */
export async function editMessageWidgetData(
  api: WidgetRawApi,
  params: EditMessageWidgetDataParams,
  signal?: AbortSignal,
): Promise<true> {
  if (
    params.inline_message_id === undefined &&
    (params.chat_id === undefined || params.message_id === undefined)
  ) {
    throw new WidgetApiError(
      'editMessageWidgetData needs chat_id and message_id, or inline_message_id',
    )
  }
  assertWidgetData('chat_data', params.chat_data)
  assertWidgetData('public_data', params.public_data)
  try {
    await callRaw(api, 'editMessageWidgetData', {...params}, signal)
    return true
  } catch (error) {
    if (isMessageNotModified(error)) return true
    throw error
  }
}

export function isMessageNotModified(error: unknown): boolean {
  return errorText(error).toLowerCase().includes('message is not modified')
}

function errorText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (current instanceof Error) {
      parts.push(current.message)
      if (current instanceof GrammyError) parts.push(current.description)
    }
    if (typeof current === 'object' && current && 'description' in current) {
      const description = Reflect.get(current, 'description')
      if (typeof description === 'string') parts.push(description)
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' ')
}

function callRaw(
  api: WidgetRawApi,
  method: 'sendWidget' | 'editMessageWidgetData',
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const fn = Reflect.get(api.raw, method)
  if (typeof fn !== 'function') {
    throw new WidgetApiError(`Bot API method ${method} is not available on api.raw`)
  }
  return (fn as RawCaller).call(api.raw, args, signal)
}

function isWidgetMessage(value: unknown): value is WidgetMessage {
  if (!value || typeof value !== 'object') return false
  const messageId = Reflect.get(value, 'message_id')
  const chat = Reflect.get(value, 'chat')
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) return false
  if (!chat || typeof chat !== 'object') return false
  const chatId = Reflect.get(chat, 'id')
  return typeof chatId === 'number' || typeof chatId === 'string'
}
