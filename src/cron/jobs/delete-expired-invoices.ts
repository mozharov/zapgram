import {CronJob} from 'cron'
import {logger} from '../../lib/logger.js'
import {deleteExpiredInvoices as deleteExpiredInvoicesFromDB} from '../../models/pending-invoice.js'

export const deleteExpiredInvoicesJob = CronJob.from({
  cronTime: '0 */10 * * * *',
  onTick: deleteExpiredInvoices,
  runOnInit: false,
  waitForCompletion: true,
})

async function deleteExpiredInvoices() {
  try {
    const deleted = await deleteExpiredInvoicesFromDB()
    logger.info(`Deleted ${deleted} expired invoices.`)
  } catch (error) {
    logger.error({error}, 'Error in deleteExpiredInvoices job')
  }
}
