import {AppError} from './app-error.js'

export class UserDoesNotHaveWalletError extends AppError {
  constructor(opts?: {message?: string; cause?: unknown}) {
    super('user_has_no_wallet', opts)
    this.name = UserDoesNotHaveWalletError.name
  }
}
