import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {HTTPError} from 'got'
import {LNBitsAPI} from './lnbits-api.js'
import type {InvoiceOrigin} from './outgoing-liquidity.js'

/**
 * LNbits pays an invoice internally when `check_internal` finds a pending incoming row
 * with that payment hash (`amount > 0`). That path never calls the funding source.
 * GET /api/v1/payments/{hash} without a wallet key is the same lookup with no wallet filter
 * (LNbits 1.7.1 `get_standalone_payment`). 200 means the invoice was issued here. 404 means
 * it was not, so paying it needs backend liquidity. Anything else is unknown and must not pause.
 */
class OriginLookup extends LNBitsAPI {
  constructor(baseUrl: string) {
    super({baseUrl})
  }

  async hasPayment(paymentHash: string): Promise<void> {
    await this.fetch(`/api/v1/payments/${paymentHash}`, undefined, {logHttpError: false})
  }
}

export function createInvoiceOriginLookup(
  baseUrl: string,
): (bolt11: string) => Promise<InvoiceOrigin> {
  const lookup = new OriginLookup(baseUrl)
  return async bolt11 => {
    let paymentHash: string
    try {
      paymentHash = decodeInvoice(bolt11).paymentHash
    } catch {
      return 'unknown'
    }
    if (!paymentHash) return 'unknown'
    try {
      await lookup.hasPayment(paymentHash)
      return 'internal'
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) return 'external'
      return 'unknown'
    }
  }
}
