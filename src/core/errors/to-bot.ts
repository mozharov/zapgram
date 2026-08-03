import {AppError} from './app-error.js'

export class ToBotError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('to_bot', opts)
    this.name = ToBotError.name
  }
}
