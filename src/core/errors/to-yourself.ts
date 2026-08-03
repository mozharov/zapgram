import {AppError} from './app-error.js'

export class ToYourselfError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('to_yourself', opts)
    this.name = ToYourselfError.name
  }
}
