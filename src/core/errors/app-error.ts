export type AppErrorCode =
  | 'insufficient_funds'
  | 'invoice_already_paid'
  | 'invoice_generation_failed'
  | 'invoice_parsing'
  | 'nwc_timeout'
  | 'nwc_connection'
  | 'nwc_payment_failed'
  | 'nwc_no_answer'
  | 'no_recipient'
  | 'to_bot'
  | 'from_bot'
  | 'to_yourself'
  | 'user_has_no_wallet'
  | 'not_found'
  | 'unknown'

export type AppErrorParams = Record<string, string | number>

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly params?: AppErrorParams

  constructor(
    code: AppErrorCode,
    opts?: {message?: string; params?: AppErrorParams; cause?: unknown},
  ) {
    super(opts?.message ?? code, {cause: opts?.cause})
    this.name = AppError.name
    this.code = code
    this.params = opts?.params
  }
}
