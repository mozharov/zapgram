import {ExposedError} from './exposed-error.js'

export class NWCPaymentFailedError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.nwc-payment-failed',
      ...args,
    })
    this.name = NWCPaymentFailedError.name
  }
}

interface ConstructorArgs {
  message?: string
}
