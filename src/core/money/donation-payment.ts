import {DEFAULT_INVOICE_EXPIRY_SECONDS} from '../lightning/invoice-expiry.js'
import {classifyPayoutLookup, type PayoutState} from '../payments/payout-state.js'

export type DonationPaymentLookup = {
  paid: boolean
  status?: string
  details: {amount: number; expiry?: Date | null}
}

export function donationInvoiceExpiresAt(expiry?: Date | null, now = new Date()): Date {
  return expiry ?? new Date(now.getTime() + DEFAULT_INVOICE_EXPIRY_SECONDS * 1000)
}

/** Paid wins over expiry: an expired invoice may have settled before the lookup. */
export function classifyDonationLookup(
  payment: DonationPaymentLookup,
  expiresAt: Date | null,
  now: Date,
): PayoutState {
  const state = classifyPayoutLookup(payment)
  if (state !== 'pending') return state
  if ((payment.details.expiry && payment.details.expiry <= now) || (expiresAt && expiresAt <= now))
    return 'retryable'
  return 'pending'
}
