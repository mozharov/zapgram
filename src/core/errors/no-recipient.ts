import {AppError} from './app-error.js'

export class NoRecipientError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('no_recipient', opts)
    this.name = NoRecipientError.name
  }
}
