import {Nip47Error} from '@getalby/sdk'

/**
 * NIP-47 has no HTTP status. A wallet that does not have this invoice answers
 * `NOT_FOUND`. Timeouts and transport errors are not a miss: the pay may still land.
 */
export function nwcInvoiceMissing(error: unknown): boolean {
  return error instanceof Nip47Error && error.code === 'NOT_FOUND'
}

/** NIP-47 times are unix seconds. Values past 1e12 are already milliseconds. */
export function unixDate(value: number | undefined): Date | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  const ms = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date
}
