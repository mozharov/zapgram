import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'
import {deleteMessageSafely} from './delete-message.js'
import type {NotificationChrome} from './notification-chrome.js'

/**
 * A callback repainting a menu screen in place — no new message, no flicker, the menu never moves.
 *
 * The edit runs *first*: when Telegram reports the message as vanished the error boundary swallows
 * it (`isVanishedTelegramMessageError`), and the tracked menu must still be intact in that case.
 * Afterwards the clicked message is adopted as the living menu, which deletes the previously
 * tracked one — that is what keeps a click on an orphaned menu from leaving two live menus behind.
 *
 * Flow surfaces (invoices, QR codes, join-request choosers, conversation hosts) must NOT use this:
 * adopting them would let the next `/wallet` delete a payment screen the user is still working in.
 */
export async function editLivingMenu<T>(
  ctx: BotContext,
  edit: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  const result = await edit()
  const messageId = ctx.callbackQuery?.message?.message_id
  if (messageId === undefined) return result
  const userId = ctx.user.id
  await chrome.adoptLivingMenu(userId, messageId).catch((error: unknown) => {
    ctx.log.warn({error, userId, messageId}, 'Failed to adopt living menu')
  })
  return result
}

export async function showLivingMenu<T extends {message_id: number}>(
  ctx: BotContext,
  send: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  if (!ctx.callbackQuery && ctx.msg) await deleteMessageSafely(ctx)
  const userId = ctx.user.id
  await chrome.deleteLivingMenu(userId).catch((error: unknown) => {
    ctx.log.warn({error, userId}, 'Failed to delete living menu')
  })
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
