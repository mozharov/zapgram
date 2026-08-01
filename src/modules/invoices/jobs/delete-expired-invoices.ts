import {logger} from '@infra/logger.js'
import {deleteExpiredInvoices as deleteExpiredInvoicesFromDB} from '@modules/invoices/repository.js'

export async function deleteExpiredInvoices(): Promise<void> {
  try {
    const deleted = await deleteExpiredInvoicesFromDB()
    logger.info(`Deleted ${deleted} expired invoices.`)
  } catch (error) {
    logger.error({error}, 'Error in deleteExpiredInvoices job')
  }
}
