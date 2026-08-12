import type {Invoice} from '@getalby/lightning-tools'
import type {ConversationContext} from '@telegram/context.js'

export function invoiceReviewHtml(
  ctx: ConversationContext,
  invoice: Invoice,
  opts: {
    usdSuffix: string
    fee: number | 'no'
    feeUsdSuffix: string
  },
): string {
  return ctx.t('wait-for-invoice-review', {
    amount: invoice.satoshi,
    usdSuffix: opts.usdSuffix,
    fee: opts.fee,
    feeUsdSuffix: opts.feeUsdSuffix,
    description: invoice.description ?? '',
    hasDescription: (!!invoice.description).toString(),
    createdDate: invoice.createdDate,
    expiryDate: invoice.expiryDate ?? 'no',
    hasExpired: invoice.hasExpired().toString(),
    invoice: invoice.paymentRequest,
  })
}
