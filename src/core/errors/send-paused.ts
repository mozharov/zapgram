import {AppError, type AppErrorAnalytics} from './app-error.js'

/** Outgoing LNbits pay refused before the payment call. */
export class SendPausedError extends AppError {
  constructor(opts?: {analytics?: AppErrorAnalytics}) {
    super('send_paused', opts)
    this.name = SendPausedError.name
  }
}

/**
 * grammY conversations 2.x runs `structuredClone` on a throw from `conversation.external`.
 * That copy keeps `message` and drops `name` and `code`, so `instanceof` is not enough.
 */
export function isSendPaused(error: unknown): boolean {
  if (error instanceof SendPausedError) return true
  if (!error || typeof error !== 'object') return false
  const record = error as {name?: unknown; code?: unknown; message?: unknown}
  return (
    record.name === SendPausedError.name ||
    record.code === 'send_paused' ||
    record.message === 'send_paused'
  )
}
