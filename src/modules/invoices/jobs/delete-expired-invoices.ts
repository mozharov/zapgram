import type {PendingInvoice} from '@infra/db/types.js'
import {captureUserEvent} from '@infra/posthog.js'
import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {
  claimPendingInvoiceByPaymentHash,
  deletePendingInvoice,
  listExpiredInvoices,
} from '@modules/invoices/repository.js'
import {syncInvoiceWidget} from '@modules/invoices/sync-invoice-widget.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {HTTPError} from 'got'
import {getRuntime} from '../../../runtime.js'

/** First failure waits a minute; repeated failures back off up to six hours. */
const EXPIRY_LOOKUP_BACKOFF_BASE_MS = 60_000
const EXPIRY_LOOKUP_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

type ExpiryLookupDefer = {attempt: number; notBefore: number}

const expiryLookupDefer = new Map<string, ExpiryLookupDefer>()

/**
 * Drop past-due pending rows. A row LNbits already marked paid takes the claim path, so the
 * receipt goes out once and the widget is not labeled expired. Only a 404 from the payment
 * lookup means the invoice is gone: a 404 from the user lookup is a different failure.
 * Other lookup failures leave the row and wait out a backoff so a stuck error is not retried
 * on every tick. One extra lookup runs before a delete, so a settle that lands after the
 * first unpaid read is claimed instead of dropped.
 */
export async function deleteExpiredInvoices(): Promise<void> {
  try {
    const expired = await listExpiredInvoices()
    const stillHere = new Set(expired.map(invoice => invoice.paymentHash))
    for (const hash of expiryLookupDefer.keys()) {
      if (!stillHere.has(hash)) expiryLookupDefer.delete(hash)
    }
    let removed = 0
    for (const invoice of expired) {
      const outcome = await settleExpiredInvoice(invoice)
      if (outcome === 'removed') removed++
    }
    getRuntime().log.info(`Deleted ${removed} expired invoices.`)
  } catch (error) {
    getRuntime().log.error({error}, 'Error in deleteExpiredInvoices job')
  }
}

async function settleExpiredInvoice(
  invoice: Awaited<ReturnType<typeof listExpiredInvoices>>[number],
): Promise<'removed' | 'claimed' | 'kept'> {
  if (expiryLookupDeferred(invoice.paymentHash)) return 'kept'

  let wallet: Awaited<ReturnType<typeof getUserWallet>>
  try {
    wallet = await getUserWallet(invoice.userId)
  } catch (error) {
    noteExpiryLookupFailure(invoice, error)
    return 'kept'
  }

  let payment: {paid: boolean}
  try {
    payment = await wallet.lookupPayment(invoice.paymentHash)
  } catch (error) {
    if (isMissingPayment(error)) return removeExpiredInvoice(invoice, 'missing')
    noteExpiryLookupFailure(invoice, error)
    return 'kept'
  }

  if (payment.paid) return claimExpiredInvoiceSafely(invoice)

  try {
    const again = await wallet.lookupPayment(invoice.paymentHash)
    if (again.paid) return claimExpiredInvoiceSafely(invoice)
  } catch (error) {
    if (!isMissingPayment(error)) {
      noteExpiryLookupFailure(invoice, error)
      return 'kept'
    }
  }

  return removeExpiredInvoice(invoice, 'unpaid')
}

/** A claim throw must not abort the rest of the expired batch. The row stays for the next tick. */
async function claimExpiredInvoiceSafely(
  invoice: Pick<PendingInvoice, 'userId' | 'paymentHash'>,
): Promise<'claimed' | 'kept'> {
  try {
    return await claimExpiredInvoice(invoice)
  } catch (error) {
    getRuntime().log.error(
      {error, userId: invoice.userId, paymentHash: invoice.paymentHash},
      'Failed to claim expired invoice',
    )
    return 'kept'
  }
}

async function claimExpiredInvoice(
  invoice: Pick<PendingInvoice, 'userId' | 'paymentHash'>,
): Promise<'claimed'> {
  clearExpiryLookupDefer(invoice.paymentHash)
  const outcome = await claimAndNotifyPaidInvoice(
    () => claimPendingInvoiceByPaymentHash(invoice.paymentHash),
    'expired_invoice_job',
  )
  if (outcome === 'notified') {
    getRuntime().log.info(
      {userId: invoice.userId, paymentHash: invoice.paymentHash},
      'Expired invoice was already paid',
    )
  } else {
    getRuntime().log.info(
      {userId: invoice.userId, paymentHash: invoice.paymentHash},
      'Expired invoice was already claimed',
    )
  }
  return 'claimed'
}

async function removeExpiredInvoice(
  invoice: Awaited<ReturnType<typeof listExpiredInvoices>>[number],
  reason: 'missing' | 'unpaid',
): Promise<'removed' | 'kept'> {
  clearExpiryLookupDefer(invoice.paymentHash)
  if (reason === 'missing') {
    getRuntime().log.warn(
      {userId: invoice.userId, paymentHash: invoice.paymentHash},
      'Expired invoice is missing on LNbits',
    )
  }

  try {
    const deleted = await deletePendingInvoice(invoice.paymentRequest)
    if (!deleted) return 'kept'
    captureUserEvent(getRuntime().posthog, 'invoice_expired', deleted.userId, {
      payment_hash: deleted.paymentHash,
    })
    await syncInvoiceWidget(deleted, 'expired')
    return 'removed'
  } catch (error) {
    getRuntime().log.error(
      {error, userId: invoice.userId, paymentHash: invoice.paymentHash},
      'Failed to delete expired invoice',
    )
    return 'kept'
  }
}

function isMissingPayment(error: unknown): boolean {
  return error instanceof HTTPError && error.response.statusCode === 404
}

function noteExpiryLookupFailure(
  invoice: Pick<PendingInvoice, 'userId' | 'paymentHash'>,
  error: unknown,
): void {
  deferExpiryLookup(invoice.paymentHash)
  getRuntime().log.error(
    {error, userId: invoice.userId, paymentHash: invoice.paymentHash},
    'Failed to check expired invoice before deleting it',
  )
}

function expiryLookupDeferred(paymentHash: string, now = Date.now()): boolean {
  const entry = expiryLookupDefer.get(paymentHash)
  return entry !== undefined && now < entry.notBefore
}

function deferExpiryLookup(paymentHash: string, now = Date.now()): void {
  const attempt = expiryLookupDefer.get(paymentHash)?.attempt ?? 0
  const delay = Math.min(
    EXPIRY_LOOKUP_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16),
    EXPIRY_LOOKUP_BACKOFF_MAX_MS,
  )
  expiryLookupDefer.set(paymentHash, {attempt: attempt + 1, notBefore: now + delay})
}

function clearExpiryLookupDefer(paymentHash: string): void {
  expiryLookupDefer.delete(paymentHash)
}
