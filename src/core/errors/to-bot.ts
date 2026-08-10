import {AppError, type AppErrorOpts} from './app-error.js'

export class ToBotError extends AppError {
  constructor(opts?: AppErrorOpts) {
    super('to_bot', opts)
    this.name = ToBotError.name
  }
}
