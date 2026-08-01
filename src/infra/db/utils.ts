import {AppError} from '@core/errors/app-error.js'

/**
 * Returns the first row or throws AppError('not_found').
 * Replaces the repeated `.then(res => res[0]!)` pattern.
 */
export function firstOrThrow<T>(rows: readonly T[], what: string): T {
  const row = rows[0]
  if (row === undefined) {
    throw new AppError('not_found', {message: `${what} not found`})
  }
  return row
}
