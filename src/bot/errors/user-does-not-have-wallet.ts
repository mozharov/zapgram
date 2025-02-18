import {ExposedError} from './exposed-error.js'

export class UserDoesNotHaveWalletError extends ExposedError {
  constructor(args?: ConstructorArgs) {
    super({
      translationKey: 'error.user-does-not-have-wallet',
      ...args,
    })
    this.name = UserDoesNotHaveWalletError.name
  }
}

interface ConstructorArgs {
  message?: string
}
