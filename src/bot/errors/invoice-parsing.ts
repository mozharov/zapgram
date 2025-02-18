import {ExposedError} from './exposed-error.js'

export class InvoiceParsingError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.invoice-parsing',
      ...args,
    })
    this.name = InvoiceParsingError.name
  }
}

interface ConstructorArgs {
  message?: string
}
