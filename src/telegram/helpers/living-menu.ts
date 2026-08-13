import type {BotContext} from '@telegram/context.js'
import type {InlineKeyboardMarkup} from 'grammy/types'
import {getRuntime} from '../../runtime.js'
import {deleteMessageSafely} from './delete-message.js'
import type {NotificationChrome} from './notification-chrome.js'

/**
 * Closes a wizard by turning its own screen into the result: `edit` repaints `messageId` with the
 * open-menu row, and that message stops being a menu and becomes the receipt holding the button.
 *
 * Prefer this over sending a separate result message — the wizard accumulates into one message the
 * way the invoice flow does, and the receipt then survives every later `/wallet`.
 */
export async function closeLivingMenu<T>(
  ctx: BotContext,
  messageId: number,
  edit: (markup: InlineKeyboardMarkup) => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  return chrome.retireMenuAsNotification(ctx.user.id, messageId, edit)
}

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

/**
 * A **new** menu message: deletes the user's triggering message and the menu this one replaces.
 *
 * Order is load-bearing, and the reason is conversation replay. Every `conversation.wait()` re-runs
 * the conversation body from the top. grammY replays `ctx.api` calls from its log, but this helper
 * reaches the database and `bot.api` directly, so those steps re-execute for real on every replay.
 * Sending **before** deleting is what makes that safe: on a replay `send()` returns the message id
 * it returned the first time, `adoptLivingMenu` sees the tracked menu is already that message, and
 * the delete is skipped. Deleting first would destroy the prompt the conversation is standing on —
 * that is the feature-request invalid-amount bug.
 *
 * `stripLastOpenMenu` clears its pointer, so it is a no-op on the replay too. `deleteMessageSafely`
 * goes through `ctx.api` and is replayed by grammY like any other context call.
 */
export async function showLivingMenu<T extends {message_id: number}>(
  ctx: BotContext,
  send: () => Promise<T>,
  chrome: NotificationChrome = getRuntime().notificationChrome,
): Promise<T> {
  if (!ctx.callbackQuery && ctx.msg) await deleteMessageSafely(ctx)
  const userId = ctx.user.id
  await chrome.stripLastOpenMenu(userId).catch((error: unknown) => {
    ctx.log.warn({error, userId}, 'Failed to strip last notification open-menu')
  })
  const sent = await send()
  if (sent?.message_id !== undefined) {
    await chrome.adoptLivingMenu(userId, sent.message_id).catch((error: unknown) => {
      ctx.log.warn({error, userId, messageId: sent.message_id}, 'Failed to adopt living menu')
    })
  }
  return sent
}
