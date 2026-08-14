import type {Api, InputFile} from 'grammy'
import {getRuntime} from '../../runtime.js'

export type Notifier = {
  /**
   * `true` when Telegram accepted the message; `false` after a logged failure. Never throws.
   * `flags.transient` marks a one-off validation/error notice: once superseded by the next
   * notification or menu, it is deleted outright instead of just losing its open-menu button.
   * `flags.withoutMenu` keeps the message out of the open-menu chain entirely — for recipients the
   * bot may not be able to write to again (see `createChromeNotifier`).
   */
  send(
    userId: number,
    text: string,
    opts?: Parameters<Api['sendMessage']>[2],
    flags?: {transient?: boolean; withoutMenu?: boolean},
  ): Promise<boolean>
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

/**
 * Leaf convenience — uses bootstrap runtime.
 *
 * The only implementation is `createChromeNotifier` (`@telegram/helpers/notification-chrome.js`),
 * wired in `createContainer`. Do not add a plain API-wrapping notifier here: anything bypassing
 * the chrome decorator drops its message out of the open-menu chain.
 */
export const notifier: Notifier = {
  send: (...args) => getRuntime().notifier.send(...args),
  sendPhoto: (...args) => getRuntime().notifier.sendPhoto(...args),
  copyMessage: (...args) => getRuntime().notifier.copyMessage(...args),
}
