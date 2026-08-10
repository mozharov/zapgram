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

/** Non-i18n context for PostHog (amounts, attempted recipients, …). */
export type AppErrorAnalytics = Record<string, string | number | boolean | null>

export type AppErrorOpts = {
  message?: string
  params?: AppErrorParams
  cause?: unknown
  analytics?: AppErrorAnalytics
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly params?: AppErrorParams
  /** Mutable so handlers can attach request context before rethrow. */
  analytics?: AppErrorAnalytics

  constructor(code: AppErrorCode, opts?: AppErrorOpts) {
    super(opts?.message ?? code, {cause: opts?.cause})
    this.name = AppError.name
    this.code = code
    this.params = opts?.params
    if (opts?.analytics) this.analytics = opts.analytics
  }
}

/** Merge analytics onto an AppError in place (no-op for other throws). */
export function attachErrorAnalytics(error: unknown, analytics: AppErrorAnalytics): void {
  if (!(error instanceof AppError)) return
  error.analytics = {...error.analytics, ...analytics}
}
