import type {Notifier} from '@modules/notifications/notifier.js'
import type {Api, InputFile} from 'grammy'

export type RecordedNotification =
  | {kind: 'send'; userId: number; text: string; opts?: Parameters<Api['sendMessage']>[2]}
  | {
      kind: 'sendPhoto'
      userId: number
      file: InputFile | string
      opts?: Parameters<Api['sendPhoto']>[2]
    }
  | {kind: 'copyMessage'; toUserId: number; fromChatId: number; messageId: number}

export function createFakeNotifier(): Notifier & {calls: RecordedNotification[]} {
  const calls: RecordedNotification[] = []
  return {
    calls,
    async send(userId, text, opts) {
      calls.push({kind: 'send', userId, text, opts})
      return true
    },
    async sendPhoto(userId, file, opts) {
      calls.push({kind: 'sendPhoto', userId, file, opts})
      return true
    },
    async copyMessage(toUserId, fromChatId, messageId) {
      calls.push({kind: 'copyMessage', toUserId, fromChatId, messageId})
      return true
    },
  }
}
