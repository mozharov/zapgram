import {AppError} from './app-error.js'

export class NWCPaymentFailedError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('nwc_payment_failed', opts)
    this.name = NWCPaymentFailedError.name
  }
}
