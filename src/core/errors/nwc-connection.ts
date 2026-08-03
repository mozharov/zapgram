import {AppError} from './app-error.js'

export class NWCConnectionError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('nwc_connection', opts)
    this.name = NWCConnectionError.name
  }
}
