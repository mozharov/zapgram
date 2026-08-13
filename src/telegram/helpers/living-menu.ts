import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'
import {deleteMessageSafely} from './delete-message.js'
import type {NotificationChrome} from './notification-chrome.js'

export type LivingMenuOptions = {
  deleteInput?: boolean
  deleteCallbackMessage?: boolean
}

export async function showLivingMenu<T extends {message_id: number}>(
  ctx: BotContext,
  send: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
  options: LivingMenuOptions = {},
): Promise<T> {
  if (options.deleteInput !== false && !ctx.callbackQuery && ctx.msg) {
    await deleteMessageSafely(ctx)
  }
  const userId = ctx.user.id
  const previousMenuMessageId = await chrome.deleteLivingMenu(userId).catch((error: unknown) => {
    ctx.log.warn({error, userId}, 'Failed to delete living menu')
    return undefined
  })
  const callbackMessage = ctx.callbackQuery?.message
  if (
    options.deleteCallbackMessage &&
    callbackMessage &&
    'message_id' in callbackMessage &&
    callbackMessage.message_id !== previousMenuMessageId
  ) {
    await deleteMessageSafely(ctx)
  }
  await chrome.stripLastOpenMenu(userId).catch((error: unknown) => {
    ctx.log.warn({error, userId}, 'Failed to strip last notification open-menu')
  })
  const sent = await send()
  if (sent?.message_id !== undefined) {
    await chrome.rememberLivingMenu(userId, sent.message_id).catch((error: unknown) => {
      ctx.log.warn({error, userId, messageId: sent.message_id}, 'Failed to remember living menu')
    })
  }
  return sent
}

export function replaceLivingMenu<T extends {message_id: number}>(
  ctx: BotContext,
  send: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  return showLivingMenu(ctx, send, chrome, {deleteInput: false})
}
