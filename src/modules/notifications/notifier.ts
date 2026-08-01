import type {AppLogger} from '@infra/logger.js'
import {logger} from '@infra/logger.js'
import {bot} from '@infra/telegram/bot.js'
import type {Api, InputFile} from 'grammy'

export type Notifier = {
  send(userId: number, text: string, opts?: Parameters<Api['sendMessage']>[2]): Promise<void>
  sendPhoto(
    userId: number,
    file: InputFile | string,
    opts?: Parameters<Api['sendPhoto']>[2],
  ): Promise<void>
}

/**
 * Telegram-backed notifier. Methods never throw — they log and return
 * (matches the previous bot.api.sendMessage(...).catch(...) pattern).
 */
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

/** Legacy singleton — removed in step 11 when bootstrap owns composition. */
export const notifier = createTelegramNotifier(bot.api, logger)
