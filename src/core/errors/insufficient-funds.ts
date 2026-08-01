import {AppError} from './app-error.js'

export class InsufficientFundsError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('insufficient_funds', opts)
    this.name = InsufficientFundsError.name
  }
}
