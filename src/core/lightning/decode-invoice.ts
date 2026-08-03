import {InvoiceParsingError} from '@core/errors/invoice-parsing.js'
import {Invoice} from '@getalby/lightning-tools'

/** Decode a bolt11 payment request, mapping library errors to InvoiceParsingError. */
export function decodeInvoice(paymentRequest: string): Invoice {
  try {
    return new Invoice({pr: paymentRequest})
  } catch (error) {
    if (error instanceof Error) throw new InvoiceParsingError({message: error.message})
    throw error
  }
}
