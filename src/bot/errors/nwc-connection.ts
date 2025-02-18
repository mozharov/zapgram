import {ExposedError} from './exposed-error.js'

export class NWCConnectionError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.nwc-connection',
      ...args,
    })
    this.name = NWCConnectionError.name
  }
}

interface ConstructorArgs {
  message?: string
}
