import {Invoice} from '@getalby/lightning-tools'
import {InvoiceParsingError} from '../bot/errors/invoice-parsing.js'

/** Decode a bolt11 payment request, mapping library errors to InvoiceParsingError. */
export function decodeInvoice(paymentRequest: string): Invoice {
  try {
    return new Invoice({pr: paymentRequest})
  } catch (error) {
    if (error instanceof Error) throw new InvoiceParsingError({message: error.message})
    throw error
  }
}
