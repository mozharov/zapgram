import {ExposedError} from './exposed-error.js'

export class FromBotError extends ExposedError {
  constructor() {
    super({
      translationKey: 'error.from-bot',
    })
    this.name = FromBotError.name
  }
}
