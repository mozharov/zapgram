import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import type {PendingInvoice} from '@infra/db/types.js'
import {captureUserEvent} from '@infra/posthog.js'
import {notifyInvoicePaid} from '@modules/invoices/notify-invoice-paid.js'
import {getRuntime} from '../../runtime.js'

export type PaidInvoiceNotifySource = 'pending_invoice_job' | 'lnbits_webhook' | 'internal_pay'

/**
 * Claim the pending row, then notify. Caller must only invoke this after knowing the invoice is
 * paid (or accepting that a race may drop a never-paid claim — only use after pay/lookup).
 *
 * Idempotent across webhook + internal pay path + cron: the first claimer notifies, later
 * callers get `already_claimed` and must stay silent.
 */
export async function claimAndNotifyPaidInvoice(
  claim: () => Promise<PendingInvoice | undefined>,
  source: PaidInvoiceNotifySource,
): Promise<'notified' | 'already_claimed'> {
  const claimed = await claim()
  if (!claimed) return 'already_claimed'

  await notifyInvoicePaid(claimed.paymentRequest, claimed.userId).catch((error: unknown) => {
    getRuntime().log.error({error, source}, 'Failed to notify user about paid invoice')
  })

  let amountSats: number | undefined
  try {
    amountSats = decodeInvoice(claimed.paymentRequest).satoshi
  } catch {
    // Analytics only — a bad bolt11 must not fail the claim path.
  }
  captureUserEvent(getRuntime().posthog, 'invoice_received', claimed.userId, {
    payment_hash: claimed.paymentHash,
    amount_sats: amountSats ?? null,
    source,
  })

  return 'notified'
}
