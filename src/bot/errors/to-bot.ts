import {ExposedError} from './exposed-error.js'

export class ToBotError extends ExposedError {
  constructor() {
    super({
      translationKey: 'error.to-bot',
    })
    this.name = ToBotError.name
  }
}
