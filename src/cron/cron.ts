import {checkPendingInvoicesJob} from './jobs/check-pending-invoices.js'
import {logger} from '../lib/logger.js'
import {deleteExpiredInvoicesJob} from './jobs/delete-expired-invoices.js'
import {checkSubscriptionPaymentsJob} from './jobs/check-subscription-payments.js'
import {checkExpiredSubscriptionsJob} from './jobs/check-expired-subscriptions.js'
import {processExpiringSubscriptionsJob} from './jobs/process-expiring-subscriptions.js'

export function startCronJobs() {
  checkPendingInvoicesJob.start()
  deleteExpiredInvoicesJob.start()
  checkSubscriptionPaymentsJob.start()
  checkExpiredSubscriptionsJob.start()
  processExpiringSubscriptionsJob.start()
  logger.info('Cron jobs started')
}

export function stopCronJobs() {
  checkPendingInvoicesJob.stop()
  deleteExpiredInvoicesJob.stop()
  checkSubscriptionPaymentsJob.stop()
  checkExpiredSubscriptionsJob.stop()
  processExpiringSubscriptionsJob.stop()
  logger.info('Cron jobs stopped')
}
