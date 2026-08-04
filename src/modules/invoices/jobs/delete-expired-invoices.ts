import {captureUserEvent} from '@infra/posthog.js'
import {deleteExpiredInvoices as deleteExpiredInvoicesFromDB} from '@modules/invoices/repository.js'
import {getRuntime} from '../../../runtime.js'

export async function deleteExpiredInvoices(): Promise<void> {
  try {
    const deleted = await deleteExpiredInvoicesFromDB()
    for (const invoice of deleted) {
      captureUserEvent(getRuntime().posthog, 'invoice_expired', invoice.userId, {
        payment_hash: invoice.paymentHash,
      })
    }
    getRuntime().log.info(`Deleted ${deleted.length} expired invoices.`)
  } catch (error) {
    getRuntime().log.error({error}, 'Error in deleteExpiredInvoices job')
  }
}
