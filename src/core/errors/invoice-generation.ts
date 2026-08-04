import {AppError} from './app-error.js'

export class InvoiceGenerationError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('invoice_generation_failed', opts)
    this.name = InvoiceGenerationError.name
  }
}
