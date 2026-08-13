import type {User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {staticCallback} from '@telegram/callback-data.js'
import {translate} from '@telegram/i18n/i18n.js'
import type {Api} from 'grammy'
import type {InlineKeyboardMarkup} from 'grammy/types'

export type InlineKeyboardJson = InlineKeyboardMarkup

export type NotificationChromeDeps = {
  findUser: (id: number) => Promise<User | null | undefined>
  updateUser: (id: number, data: Partial<User>) => Promise<unknown>
  editMessageReplyMarkup: (
    chatId: number,
    messageId: number,
    extra: {reply_markup: InlineKeyboardJson},
  ) => Promise<unknown>
  deleteMessage: (chatId: number, messageId: number) => Promise<unknown>
  log: Pick<AppLogger, 'warn'>
}

export function createNotificationChrome(deps: NotificationChromeDeps) {
  async function forgetNotification(userId: number): Promise<void> {
    try {
      await deps.updateUser(userId, {
        lastNotificationMessageId: null,
        lastNotificationBaseMarkup: null,
      })
    } catch (error) {
      deps.log.warn({error, userId}, 'Failed to clear last notification pointer')
    }
  }

  /**
   * Clears the pointer on success as well as on failure: once stripped, that message no longer
   * carries an open-menu row, so it is no longer "the notification holding the button". That also
   * makes a second call a cheap no-op, which is what keeps a conversation replay from re-editing it.
   */
  async function stripLastOpenMenu(userId: number): Promise<void> {
    try {
      const user = await deps.findUser(userId)
      if (!user?.lastNotificationMessageId) return
      const base = parseBaseMarkup(user.lastNotificationBaseMarkup)
      try {
        await deps.editMessageReplyMarkup(userId, user.lastNotificationMessageId, {
          reply_markup: base ?? {inline_keyboard: []},
        })
      } catch (error) {
        deps.log.warn(
          {error, userId, messageId: user.lastNotificationMessageId},
          'Failed to strip open-menu from last notification',
        )
      }
      await forgetNotification(userId)
    } catch (error) {
      deps.log.warn({error, userId}, 'Failed to strip last notification open-menu')
    }
  }

  async function deliver<T extends {message_id: number}>(
    userId: number,
    baseMarkup: InlineKeyboardJson | undefined,
    send: (markup: InlineKeyboardJson) => Promise<T>,
  ): Promise<T> {
    const user = await deps.findUser(userId)
    const markup = appendOpenMenu(baseMarkup, user?.languageCode ?? 'en')
    // Send before stripping: a refused send must leave the previous receipt's button intact rather
    // than strand the user with no way back to the menu.
    const sent = await send(markup)
    await stripLastOpenMenu(userId).catch((error: unknown) => {
      deps.log.warn({error, userId}, 'Failed to strip previous notification after deliver')
    })
    try {
      if (user) {
        await deps.updateUser(userId, {
          lastNotificationMessageId: sent.message_id,
          lastNotificationBaseMarkup: serializeBaseMarkup(baseMarkup),
        })
      }
    } catch (error) {
      deps.log.warn(
        {error, userId, messageId: sent.message_id},
        'Failed to remember last notification',
      )
    }
    return sent
  }

  /**
   * A wizard's terminal screen: `edit` repaints `messageId` with the open-menu row appended, and the
   * pointers swap — that message stops being a menu and becomes the notification holding the button.
   *
   * So it behaves like every other receipt: the next `/wallet` leaves it alone instead of deleting it
   * with the menu it used to be, and pressing its button strips the row and sends a fresh menu. Use
   * it to close a conversation in place rather than sending a separate result message.
   */
  async function retireMenuAsNotification<T>(
    userId: number,
    messageId: number,
    edit: (markup: InlineKeyboardJson) => Promise<T>,
  ): Promise<T> {
    const user = await deps.findUser(userId)
    const result = await edit(appendOpenMenu(undefined, user?.languageCode ?? 'en'))
    // Skip when this message already is the tracked notification: stripping would pull off the row
    // the edit just added.
    if (user?.lastNotificationMessageId !== messageId) {
      await stripLastOpenMenu(userId).catch((error: unknown) => {
        deps.log.warn({error, userId}, 'Failed to strip previous notification while retiring menu')
      })
    }
    try {
      if (user) {
        const data: Partial<User> = {
          lastNotificationMessageId: messageId,
          lastNotificationBaseMarkup: null,
        }
        if (user.lastMenuMessageId === messageId) data.lastMenuMessageId = null
        await deps.updateUser(userId, data)
      }
    } catch (error) {
      deps.log.warn({error, userId, messageId}, 'Failed to retire living menu as notification')
    }
    return result
  }

  /**
   * `messageId` *is* the living menu now — either a callback repainted it in place, or it is a
   * freshly sent menu. Drop whatever the pointer still names and aim it here.
   *
   * The equal-id early return is what makes this the single entry point for both cases: it costs no
   * API call in the common callback path, and it is what makes a conversation replay harmless, since
   * a replayed `send()` returns the id already tracked. There is deliberately no "delete the tracked
   * menu" primitive next to this one — deleting before the replacement exists is what let a replay
   * destroy the prompt it was standing on.
   */
  async function adoptLivingMenu(userId: number, messageId: number): Promise<void> {
    try {
      const user = await deps.findUser(userId)
      if (!user || user.lastMenuMessageId === messageId) return
      if (user.lastMenuMessageId) {
        try {
          await deps.deleteMessage(userId, user.lastMenuMessageId)
        } catch (error) {
          deps.log.warn(
            {error, userId, messageId: user.lastMenuMessageId},
            'Failed to delete superseded living menu',
          )
        }
      }
      const data: Partial<User> = {lastMenuMessageId: messageId}
      // A receipt edited into a menu: a later notification must not restore its base keyboard.
      if (user.lastNotificationMessageId === messageId) {
        data.lastNotificationMessageId = null
        data.lastNotificationBaseMarkup = null
      }
      await deps.updateUser(userId, data)
    } catch (error) {
      deps.log.warn({error, userId, messageId}, 'Failed to adopt living menu')
    }
  }

  return {stripLastOpenMenu, deliver, adoptLivingMenu, retireMenuAsNotification}
}

export type NotificationChrome = ReturnType<typeof createNotificationChrome>

export function appendOpenMenu(
  baseMarkup: InlineKeyboardJson | undefined,
  languageCode: string,
): InlineKeyboardJson {
  const rows = baseMarkup?.inline_keyboard?.map(row => row.map(button => ({...button}))) ?? []
  rows.push([
    {text: translate('button.open-wallet', languageCode), callback_data: staticCallback.openMenu},
  ])
  return {inline_keyboard: rows}
}

export function createChromeNotifier(
  api: Api,
  log: AppLogger,
  chrome: NotificationChrome,
): Notifier {
  return {
    async send(userId, text, opts) {
      try {
        await chrome.deliver(userId, markupFromReplyMarkup(opts?.reply_markup), markup =>
          api.sendMessage(userId, text, {...opts, reply_markup: markup}),
        )
        return true
      } catch (error) {
        log.error({error}, 'Failed to send Telegram message')
        return false
      }
    },
    async sendPhoto(userId, file, opts) {
      try {
        await chrome.deliver(userId, markupFromReplyMarkup(opts?.reply_markup), markup =>
          api.sendPhoto(userId, file, {...opts, reply_markup: markup}),
        )
        return true
      } catch (error) {
        log.error({error}, 'Failed to send Telegram photo')
        return false
      }
    },
    async copyMessage(toUserId, fromChatId, messageId) {
      try {
        await chrome.deliver(toUserId, undefined, markup =>
          api.copyMessage(toUserId, fromChatId, messageId, {reply_markup: markup}),
        )
        return true
      } catch (error) {
        log.error({error, toUserId, fromChatId, messageId}, 'Failed to copy Telegram message')
        return false
      }
    },
  }
}

export function serializeBaseMarkup(baseMarkup: InlineKeyboardJson | undefined): string | null {
  const rows = baseMarkup?.inline_keyboard
  if (!rows || rows.length === 0) return null
  return JSON.stringify({inline_keyboard: rows})
}

export function parseBaseMarkup(raw: string | null | undefined): InlineKeyboardJson | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('inline_keyboard' in parsed)) return null
    const keyboard = (parsed as InlineKeyboardJson).inline_keyboard
    if (!Array.isArray(keyboard)) return null
    return {inline_keyboard: keyboard}
  } catch {
    return null
  }
}

export function markupFromReplyMarkup(replyMarkup: unknown): InlineKeyboardJson | undefined {
  if (!replyMarkup || typeof replyMarkup !== 'object') return undefined
  if (!('inline_keyboard' in replyMarkup)) return undefined
  const keyboard = (replyMarkup as InlineKeyboardJson).inline_keyboard
  if (!Array.isArray(keyboard)) return undefined
  return {inline_keyboard: keyboard}
}
