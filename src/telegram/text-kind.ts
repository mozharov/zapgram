import {type PaymentRequestKind, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {looksLikeOnchainAddress} from '@core/onchain/looks-like-address.js'

/**
 * Label for a private message. Lightning kinds come only from
 * `recognizePaymentRequest`; on-chain comes only from `looksLikeOnchainAddress`.
 * The return value is the label alone. Storing the message body is a separate
 * decision on `dm_unrecognized_text`; this function does not hash or rewrite it.
 */
export const TEXT_KINDS = [
  'bolt11_invoice',
  'lnurl',
  'lightning_address',
  'onchain_address',
  'other',
] as const

export type TextKind = (typeof TEXT_KINDS)[number]

export function classifyTextKind(text: string): TextKind {
  const kind = recognizePaymentRequest(text)?.kind
  if (kind === undefined) {
    return looksLikeOnchainAddress(text) ? 'onchain_address' : 'other'
  }
  return fromPaymentRequest(kind)
}

function fromPaymentRequest(kind: PaymentRequestKind): TextKind {
  switch (kind) {
    case 'bolt11':
      return 'bolt11_invoice'
    case 'lnurl':
      return 'lnurl'
    case 'lightning-address':
      return 'lightning_address'
  }
}
