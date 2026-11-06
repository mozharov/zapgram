import {sanitizeMemo} from '@core/lightning/memo.js'
import type {Invoice} from '@getalby/lightning-tools'
import type {ConversationContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'
import {clipLnurlDisplay, escapeTelegramHtml, flattenServiceText} from '../lnurl-payee.js'

/**
 * Invoice `d` is chosen by whoever minted the BOLT11, including an LNURL callback
 * that also sent a valid `h`. It is a note, not markup: one line, no bidi controls,
 * clipped, then escaped for the confirm screen.
 */
export function screenInvoiceDescription(raw: string): string {
  return escapeTelegramHtml(clipLnurlDisplay(flattenServiceText(raw)))
}

export function visibleInvoiceDescription(raw: string | undefined | null): string {
  return screenInvoiceDescription(sanitizeMemo(raw ?? '', getRuntime().config.memoFooter))
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
