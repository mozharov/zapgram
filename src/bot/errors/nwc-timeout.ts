import {ExposedError} from './exposed-error.js'

export class NWCTimeoutError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.nwc-timeout',
      ...args,
    })
    this.name = NWCTimeoutError.name
  }
}

interface ConstructorArgs {
  message?: string
}
