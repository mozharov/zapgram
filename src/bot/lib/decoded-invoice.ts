import {InvoiceParsingError} from '../errors/invoice-parsing.js'
import {Invoice} from '@getalby/lightning-tools'

export function decodeInvoice(paymentRequest: string): DecodedInvoice {
  try {
    return new DecodedInvoice(paymentRequest)
  } catch (error) {
    if (error instanceof Error) throw new InvoiceParsingError({message: error.message})
    throw error
  }
}

export class DecodedInvoice extends Invoice {
  constructor(paymentRequest: string) {
    super({pr: paymentRequest})
  }

  public get msats(): number {
    return this.satoshi * 1000
  }
}
