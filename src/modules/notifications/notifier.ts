import type {AppLogger} from '@infra/logger.js'
import type {Api, InputFile} from 'grammy'
import {getRuntime} from '../../runtime.js'

export type Notifier = {
  send(userId: number, text: string, opts?: Parameters<Api['sendMessage']>[2]): Promise<void>
  sendPhoto(
    userId: number,
    file: InputFile | string,
    opts?: Parameters<Api['sendPhoto']>[2],
  ): Promise<void>
}

/** Telegram-backed notifier. Methods never throw — they log and return. */
export function createTelegramNotifier(api: Api, log: AppLogger): Notifier {
  return {
    async send(userId, text, opts) {
      try {
        await api.sendMessage(userId, text, opts)
      } catch (error) {
        log.error({error}, 'Failed to send Telegram message')
      }
    },
    async sendPhoto(userId, file, opts) {
      try {
        await api.sendPhoto(userId, file, opts)
      } catch (error) {
        log.error({error}, 'Failed to send Telegram photo')
      }
    },
  }
}

/** Leaf convenience — uses bootstrap runtime. */
export const notifier: Notifier = {
  send: (...args) => getRuntime().notifier.send(...args),
  sendPhoto: (...args) => getRuntime().notifier.sendPhoto(...args),
}
