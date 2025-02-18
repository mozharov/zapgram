import {ExposedError} from './exposed-error.js'

export class NoNWCAnswerError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.no-nwc-answer',
      ...args,
    })
    this.name = NoNWCAnswerError.name
  }
}

interface ConstructorArgs {
  message?: string
}
