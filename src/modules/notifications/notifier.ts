import type {AppLogger} from '@infra/logger.js'
import type {Api, InputFile} from 'grammy'
import {getRuntime} from '../../runtime.js'

export type Notifier = {
  /** `true` when Telegram accepted the message; `false` after a logged failure. Never throws. */
  send(userId: number, text: string, opts?: Parameters<Api['sendMessage']>[2]): Promise<boolean>
  /** `true` when Telegram accepted the photo; `false` after a logged failure. Never throws. */
  sendPhoto(
    userId: number,
    file: InputFile | string,
    opts?: Parameters<Api['sendPhoto']>[2],
  ): Promise<boolean>
  /**
   * Copy a message the bot already received into another chat (no “Forwarded from” header).
   * `true` when Telegram accepted the copy.
   */
  copyMessage(toUserId: number, fromChatId: number, messageId: number): Promise<boolean>
}

/** Telegram-backed notifier. Methods never throw — they log and return success/failure. */
export function createTelegramNotifier(api: Api, log: AppLogger): Notifier {
  return {
    async send(userId, text, opts) {
      try {
        await api.sendMessage(userId, text, opts)
        return true
      } catch (error) {
        log.error({error}, 'Failed to send Telegram message')
        return false
      }
    },
    async sendPhoto(userId, file, opts) {
      try {
        await api.sendPhoto(userId, file, opts)
        return true
      } catch (error) {
        log.error({error}, 'Failed to send Telegram photo')
        return false
      }
    },
    async copyMessage(toUserId, fromChatId, messageId) {
      try {
        await api.copyMessage(toUserId, fromChatId, messageId)
        return true
      } catch (error) {
        log.error({error, toUserId, fromChatId, messageId}, 'Failed to copy Telegram message')
        return false
      }
    },
  }
}

/** Leaf convenience — uses bootstrap runtime. */
export const notifier: Notifier = {
  send: (...args) => getRuntime().notifier.send(...args),
  sendPhoto: (...args) => getRuntime().notifier.sendPhoto(...args),
  copyMessage: (...args) => getRuntime().notifier.copyMessage(...args),
}
