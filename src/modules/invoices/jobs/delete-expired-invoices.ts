import {deleteExpiredInvoices as deleteExpiredInvoicesFromDB} from '@modules/invoices/repository.js'
import {getRuntime} from '../../../runtime.js'

export async function deleteExpiredInvoices(): Promise<void> {
  try {
    const deleted = await deleteExpiredInvoicesFromDB()
    getRuntime().log.info(`Deleted ${deleted} expired invoices.`)
  } catch (error) {
    getRuntime().log.error({error}, 'Error in deleteExpiredInvoices job')
  }
}
