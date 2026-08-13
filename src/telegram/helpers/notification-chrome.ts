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
        await forgetNotification(userId)
      }
    } catch (error) {
      deps.log.warn({error, userId}, 'Failed to strip last notification open-menu')
    }
  }

  async function deliver<T extends {message_id: number}>(
    userId: number,
    baseMarkup: InlineKeyboardJson | undefined,
    send: (markup: InlineKeyboardJson) => Promise<T>,
  ): Promise<T> {
    await stripLastOpenMenu(userId).catch((error: unknown) => {
      deps.log.warn({error, userId}, 'Failed to strip last notification before deliver')
    })
    const user = await deps.findUser(userId)
    const markup = appendOpenMenu(baseMarkup, user?.languageCode ?? 'en')
    const sent = await send(markup)
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

  async function deleteLivingMenu(userId: number): Promise<void> {
    try {
      const user = await deps.findUser(userId)
      if (!user?.lastMenuMessageId) return
      try {
        await deps.deleteMessage(userId, user.lastMenuMessageId)
      } catch (error) {
        deps.log.warn(
          {error, userId, messageId: user.lastMenuMessageId},
          'Failed to delete living menu',
        )
        try {
          await deps.updateUser(userId, {lastMenuMessageId: null})
        } catch (clearError) {
          deps.log.warn({error: clearError, userId}, 'Failed to clear last menu pointer')
        }
      }
    } catch (error) {
      deps.log.warn({error, userId}, 'Failed to delete living menu')
    }
  }

  async function rememberLivingMenu(userId: number, messageId: number): Promise<void> {
    try {
      const user = await deps.findUser(userId)
      if (!user) return
      await deps.updateUser(userId, {lastMenuMessageId: messageId})
    } catch (error) {
      deps.log.warn({error, userId, messageId}, 'Failed to remember living menu')
    }
  }

  return {stripLastOpenMenu, deliver, deleteLivingMenu, rememberLivingMenu}
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
