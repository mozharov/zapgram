import {checkPendingInvoicesJob} from './jobs/check-pending-invoices.js'
import {logger} from '../lib/logger.js'
import {deleteExpiredInvoicesJob} from './jobs/delete-expired-invoices.js'

export function startCronJobs() {
  checkPendingInvoicesJob.start()
  deleteExpiredInvoicesJob.start()
  logger.info('Cron jobs started')
}

export function stopCronJobs() {
  checkPendingInvoicesJob.stop()
  deleteExpiredInvoicesJob.stop()
  logger.info('Cron jobs stopped')
}
