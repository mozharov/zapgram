import {AppError} from './app-error.js'

export class FromBotError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('from_bot', opts)
    this.name = FromBotError.name
  }
}
