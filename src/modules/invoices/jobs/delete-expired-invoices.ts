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

/**
 * Drop past-due pending rows. A row LNbits already marked paid takes the same claim path as the
 * pending-invoice job, so the receipt goes out once and the widget is not labeled expired.
 * Lookup failures leave the row in place so a later tick can still claim it.
 */
export async function deleteExpiredInvoices(): Promise<void> {
  try {
    const expired = await listExpiredInvoices()
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
  try {
    const wallet = await getUserWallet(invoice.userId)
    const payment = await wallet.lookupPayment(invoice.paymentHash)
    if (payment.paid) {
      // Same atomic claim as the webhook and the pending-invoice job. The loser stays silent.
      await claimAndNotifyPaidInvoice(
        () => claimPendingInvoiceByPaymentHash(invoice.paymentHash),
        'pending_invoice_job',
      )
      getRuntime().log.info(
        {userId: invoice.userId, paymentHash: invoice.paymentHash},
        'Expired invoice was already paid',
      )
      return 'claimed'
    }
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.statusCode !== 404) {
      getRuntime().log.error(
        {error, userId: invoice.userId, paymentHash: invoice.paymentHash},
        'Failed to check expired invoice before deleting it',
      )
      return 'kept'
    }
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
