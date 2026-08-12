import {sanitizeMemo} from '@core/lightning/memo.js'
import type {Invoice} from '@getalby/lightning-tools'
import type {ConversationContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export function visibleInvoiceDescription(raw: string | undefined | null): string {
  return sanitizeMemo(raw ?? '', getRuntime().config.memoFooter)
}

export function invoiceReviewHtml(
  ctx: ConversationContext,
  invoice: Invoice,
  opts: {
    usdSuffix: string
    fee: number | 'no'
    feeUsdSuffix: string
  },
): string {
  const description = visibleInvoiceDescription(invoice.description)
  return ctx.t('wait-for-invoice-review', {
    amount: invoice.satoshi,
    usdSuffix: opts.usdSuffix,
    fee: opts.fee,
    feeUsdSuffix: opts.feeUsdSuffix,
    description,
    hasDescription: (!!description).toString(),
    createdDate: invoice.createdDate,
    expiryDate: invoice.expiryDate ?? 'no',
    hasExpired: invoice.hasExpired().toString(),
    invoice: invoice.paymentRequest,
  })
}
