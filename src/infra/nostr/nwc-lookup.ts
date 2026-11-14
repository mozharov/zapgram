import {Nip47Error} from '@getalby/sdk'

/**
 * NIP-47 has no HTTP status. A wallet that does not have this invoice answers
 * `NOT_FOUND`. Timeouts and transport errors are not a miss: the pay may still land.
 */
export function nwcInvoiceMissing(error: unknown): boolean {
  return error instanceof Nip47Error && error.code === 'NOT_FOUND'
}
