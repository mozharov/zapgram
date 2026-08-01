import {AppError} from './app-error.js'

export class InvoiceAlreadyPaidError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('invoice_already_paid', opts)
    this.name = InvoiceAlreadyPaidError.name
  }
}
