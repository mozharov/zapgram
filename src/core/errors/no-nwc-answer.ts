import {AppError} from './app-error.js'

export class NoNWCAnswerError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('nwc_no_answer', opts)
    this.name = NoNWCAnswerError.name
  }
}
