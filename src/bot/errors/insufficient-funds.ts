import {ExposedError} from './exposed-error.js'

export class InsufficientFundsError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.insufficient-funds',
      ...args,
    })
    this.name = InsufficientFundsError.name
  }
}

interface ConstructorArgs {
  message?: string
}
