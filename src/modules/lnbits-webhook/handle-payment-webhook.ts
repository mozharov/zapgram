import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {claimPendingInvoiceByPaymentHash} from '@modules/invoices/repository.js'
import {getSubscriptionPaymentByHash} from '@modules/subscriptions/payment-repository.js'
import {completeSubscriptionPayment} from '@modules/subscriptions/settle.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {getRuntime} from '../../runtime.js'

export type LnbitsWebhookResult =
  | 'invoice_notified'
  | 'subscription_settled'
  | 'already_handled'
  | 'unpaid'
  | 'unknown'

/**
 * Push path for paid LNbits invoices. Cron remains the safety net when this never fires.
 *
 * Pending-invoice notify is claim-based so internal pay (bot → bot) cannot double-message the
 * recipient if LNbits also POSTs a webhook for the same payment.
 */
export async function handleLnbitsPaymentWebhook(
  paymentHash: string,
): Promise<LnbitsWebhookResult> {
  const pending = await getRuntime().invoices.findByPaymentHash(paymentHash)
  if (pending) {
    const wallet = await getUserWallet(pending.userId)
    const lookup = await wallet.lookupPayment(paymentHash)
    if (!lookup.paid) return 'unpaid'

    const outcome = await claimAndNotifyPaidInvoice(
      () => claimPendingInvoiceByPaymentHash(paymentHash),
      'lnbits_webhook',
    )
    return outcome === 'notified' ? 'invoice_notified' : 'already_handled'
  }

  const subscriptionPayment = await getSubscriptionPaymentByHash(paymentHash)
  if (subscriptionPayment) {
    const lookup = await getRuntime().masterWallet.lookupPayment(paymentHash)
    if (!lookup.paid) return 'unpaid'

    const settle = await completeSubscriptionPayment(subscriptionPayment)
    // `kept` means settle left the row for a later retry (payout still in flight, etc.).
    return settle === 'settled' ? 'subscription_settled' : 'already_handled'
  }

  return 'unknown'
}

export function extractPaymentHashFromLnbitsWebhook(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>

  if (typeof record.payment_hash === 'string' && record.payment_hash.length > 0) {
    return record.payment_hash
  }
  if (typeof record.paymentHash === 'string' && record.paymentHash.length > 0) {
    return record.paymentHash
  }
  if (record.details && typeof record.details === 'object') {
    const details = record.details as Record<string, unknown>
    if (typeof details.payment_hash === 'string' && details.payment_hash.length > 0) {
      return details.payment_hash
    }
  }
  // Some LNbits versions use checking_id equal to the payment hash for Lightning payments.
  if (typeof record.checking_id === 'string' && record.checking_id.length > 0) {
    return record.checking_id
  }
  return undefined
}
