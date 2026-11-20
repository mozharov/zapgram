import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {Nip47Error} from '@getalby/sdk'
import {validPreimage} from './wallet.js'

export function classifyNwcInvoiceLookup(
  found: {preimage?: string | null; settled_at?: number},
  bolt11: string,
  hash: string,
): {state: 'paid' | 'pending' | 'unknown'; paidAt?: Date} {
  if (!found.preimage) return {state: 'pending'}
  const {paymentHash} = decodeInvoice(bolt11)
  if (paymentHash !== hash || !validPreimage(found.preimage, paymentHash)) {
    // An invalid receipt cannot release the hold: the original debit may still land.
    return {state: 'unknown'}
  }
  return {state: 'paid', paidAt: unixDate(found.settled_at)}
}

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
