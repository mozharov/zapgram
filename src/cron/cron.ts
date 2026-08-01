import {logger} from '@infra/logger.js'
import {checkPendingInvoicesJob} from '@modules/invoices/jobs/check-pending-invoices.js'
import {deleteExpiredInvoicesJob} from '@modules/invoices/jobs/delete-expired-invoices.js'
import {checkExpiredSubscriptionsJob} from '@modules/subscriptions/jobs/check-expired-subscriptions.js'
import {checkSubscriptionPaymentsJob} from '@modules/subscriptions/jobs/check-subscription-payments.js'
import {processExpiringSubscriptionsJob} from '@modules/subscriptions/jobs/process-expiring-subscriptions.js'

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
