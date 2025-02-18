import {ExposedError} from './exposed-error.js'

export class NoRecipientError extends ExposedError {
  constructor() {
    super({
      translationKey: 'error.no-recipient',
    })
    this.name = NoRecipientError.name
  }
}
