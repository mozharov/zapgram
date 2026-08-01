import {AppError} from './app-error.js'

export class InvoiceParsingError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('invoice_parsing', opts)
    this.name = InvoiceParsingError.name
  }
}
