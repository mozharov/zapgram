import {captureUserEvent} from '@infra/posthog.js'
import {runBatch} from '@jobs/run-batch.js'
import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {
  claimPendingInvoiceByPaymentHash,
  countPendingInvoices,
  deletePendingInvoice,
  getPendingInvoices,
} from '@modules/invoices/repository.js'
import {syncInvoiceWidget} from '@modules/invoices/sync-invoice-widget.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {HTTPError} from 'got'
import {getRuntime} from '../../../runtime.js'

export async function checkPendingInvoices(): Promise<void> {
  try {
    await runBatch({
      name: 'pending invoices',
      log: getRuntime().log,
      count: () => countPendingInvoices(),
      fetch: (limit, offset) => getPendingInvoices(limit, offset),
      process: async invoice => {
        try {
          const wallet = await getUserWallet(invoice.userId)
          const payment = await wallet.lookupPayment(invoice.paymentHash)

          if (payment.paid) {
            // Claim first so a concurrent webhook / internal-pay path cannot double-notify.
            await claimAndNotifyPaidInvoice(
              () => claimPendingInvoiceByPaymentHash(invoice.paymentHash),
              'pending_invoice_job',
            )
            return 'done'
          }
          return 'keep'
        } catch (error) {
          getRuntime().log.error({error}, `Error processing invoice ${invoice.paymentHash}.`)

          if (error instanceof HTTPError && error.response.statusCode === 404) {
            getRuntime().log.error(`Invoice ${invoice.paymentHash} not found on LNBits. Deleting.`)
            // Delete first. The returned row is the pointer that still belonged to this
            // request; a stale batch snapshot must not mark a message that now shows another invoice.
            try {
              const deleted = await deletePendingInvoice(invoice.paymentRequest)
              if (deleted) {
                await syncInvoiceWidget(deleted, 'cancelled')
                captureUserEvent(getRuntime().posthog, 'invoice_dropped', deleted.userId, {
                  payment_hash: deleted.paymentHash,
                  reason: 'not_found_on_lnbits',
                })
              }
              return 'done'
            } catch (deleteError: unknown) {
              getRuntime().log.error(
                {error: deleteError},
                `Failed to delete not-found invoice ${invoice.paymentRequest}`,
              )
              return 'keep'
            }
          }
          if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
            getRuntime().log.warn(
              `Timeout checking invoice ${invoice.paymentHash}. Will retry later.`,
            )
            return 'keep'
          }
          getRuntime().log.error(
            {error},
            `Unhandled error processing invoice ${invoice.paymentHash}.`,
          )
          return 'keep'
        }
      },
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in checkPendingInvoices job.')
  }
}
