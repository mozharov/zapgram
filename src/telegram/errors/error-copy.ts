import type {AppErrorCode} from '@core/errors/app-error.js'

/**
 * Maps domain error codes to Fluent translation keys used by the bot UI.
 * Keys match the previous `translationKey` values on bot error classes.
 */
export const errorTranslationKey: Record<AppErrorCode, string> = {
  insufficient_funds: 'error.insufficient-funds',
  invoice_already_paid: 'error.invoice-already-paid',
  invoice_generation_failed: 'error.invoice-generation-failed',
  invoice_parsing: 'error.invoice-parsing',
  nwc_timeout: 'error.nwc-timeout',
  nwc_connection: 'error.nwc-connection',
  nwc_payment_failed: 'error.nwc-payment-failed',
  nwc_no_answer: 'error.no-nwc-answer',
  no_recipient: 'error.no-recipient',
  to_bot: 'error.to-bot',
  from_bot: 'error.from-bot',
  to_yourself: 'error.to-yourself',
  user_has_no_wallet: 'error.user-does-not-have-wallet',
  // No dedicated copy yet; fall back to the generic unknown error message.
  not_found: 'error.unknown',
  unknown: 'error.unknown',
}
