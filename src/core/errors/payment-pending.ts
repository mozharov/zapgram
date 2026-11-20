import {AppError} from './app-error.js'

/** The wallet may have debited the payment. Only a lookup can resolve it. */
export class PaymentPendingError extends AppError {
  constructor() {
    super('payment_pending')
    this.name = PaymentPendingError.name
  }
}
