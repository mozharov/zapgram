import {ExposedError} from './exposed-error.js'

export class InvoiceAlreadyPaidError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.invoice-already-paid',
      ...args,
    })
    this.name = InvoiceAlreadyPaidError.name
  }
}

interface ConstructorArgs {
  message?: string
}
