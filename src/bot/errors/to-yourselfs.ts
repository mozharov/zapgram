import {ExposedError} from './exposed-error.js'

export class ToYourselfError extends ExposedError {
  constructor() {
    super({
      translationKey: 'error.to-yourself',
    })
    this.name = ToYourselfError.name
  }
}
