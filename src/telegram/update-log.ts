import type {Context} from 'grammy'
import {resolveUpdateEventName} from './analytics.js'

/**
 * Child-logger bindings for one Telegram update. Every line written while the update is being
 * handled inherits them, so any log record can be traced back to the exact interaction
 * (`reqId` + `action` + `userId`) instead of a bare `POST /bot`.
 *
 * `action` reuses the PostHog event name (`command_wallet`, `callback_pay_onchain`, …) so a log
 * line and the analytics event for the same interaction are searchable under one name.
 */
export type UpdateLogContext = {
  updateId?: number
  updateType?: string
  action: string
  chatId?: number
  chatType?: string
  userId?: number
  username?: string
  callbackData?: string
  command?: string
  textLength?: number
}

/**
 * Message text is deliberately absent: users paste NWC connection secrets, invoices and other
 * sensitive strings into the bot. Only the shape (length) and the command name are recorded.
 */
export function describeUpdate(ctx: Context): UpdateLogContext {
  const description: UpdateLogContext = {action: resolveUpdateEventName(ctx)}

  const updateId = ctx.update.update_id
  if (typeof updateId === 'number') description.updateId = updateId

  const updateType = updateTypeOf(ctx)
  if (updateType) description.updateType = updateType

  if (ctx.chat) {
    description.chatId = ctx.chat.id
    description.chatType = ctx.chat.type
  }

  if (ctx.from) {
    description.userId = ctx.from.id
    if (ctx.from.username) description.username = ctx.from.username
  }

  const callbackData = ctx.callbackQuery?.data
  if (callbackData !== undefined) description.callbackData = callbackData

  const text = ctx.message?.text ?? ctx.message?.caption
  if (text !== undefined) {
    description.textLength = text.length
    const command = text.match(/^\/([a-zA-Z0-9_]+)/)?.[1]?.split('@')[0]
    if (command) description.command = command
  }

  return description
}

/** `reqId` is stamped onto the update body by the HTTP router, so it is not an update type. */
function updateTypeOf(ctx: Context): string | undefined {
  return Object.keys(ctx.update).find(key => key !== 'update_id' && key !== 'reqId')
}
