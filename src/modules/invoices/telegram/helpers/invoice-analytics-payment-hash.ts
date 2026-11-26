import {decodeInvoice} from '@core/lightning/decode-invoice.js'

export function invoiceAnalyticsPaymentHash(invoice: {
  paymentRequest: string
  paymentHash?: string
}): string | undefined {
  if (invoice.paymentHash) return invoice.paymentHash
  try {
    return decodeInvoice(invoice.paymentRequest).paymentHash
  } catch {
    // Optional analytics metadata must not interrupt an already minted invoice.
    return undefined
  }
}
