import {AppError} from './app-error.js'

export class NWCTimeoutError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('nwc_timeout', opts)
    this.name = NWCTimeoutError.name
  }
}
