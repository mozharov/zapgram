import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'
import {deleteMessageSafely} from './delete-message.js'
import type {NotificationChrome} from './notification-chrome.js'

export async function showLivingMenu<T extends {message_id: number}>(
  ctx: BotContext,
  send: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  if (!ctx.callbackQuery && ctx.msg) await deleteMessageSafely(ctx)
  const userId = ctx.user.id
  await chrome.deleteLivingMenu(userId)
  await chrome.stripLastOpenMenu(userId)
  const sent = await send()
  await chrome.rememberLivingMenu(userId, sent.message_id)
  return sent
}
