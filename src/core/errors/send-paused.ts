import {AppError, type AppErrorAnalytics} from './app-error.js'

/** Outgoing LNbits pay refused before the payment call. */
export class SendPausedError extends AppError {
  constructor(opts?: {analytics?: AppErrorAnalytics}) {
    super('send_paused', opts)
    this.name = SendPausedError.name
  }
}

export function throwIfSendPaused(error: unknown): void {
  if (error instanceof SendPausedError) throw error
}
