import {logger} from '@infra/logger.js'
import {checkPendingInvoices} from '@modules/invoices/jobs/check-pending-invoices.js'
import {deleteExpiredInvoices} from '@modules/invoices/jobs/delete-expired-invoices.js'
import {checkExpiredSubscriptions} from '@modules/subscriptions/jobs/check-expired-subscriptions.js'
import {checkSubscriptionPayments} from '@modules/subscriptions/jobs/check-subscription-payments.js'
import {processExpiringSubscriptions} from '@modules/subscriptions/jobs/process-expiring-subscriptions.js'
import {CronJob} from 'cron'

export type JobDefinition = {
  name: string
  cronTime: string
  runOnInit: boolean
  tick: () => Promise<void> | void
}

const jobDefinitions: JobDefinition[] = [
  {
    name: 'check-pending-invoices',
    cronTime: '0 */2 * * * *',
    runOnInit: false,
    tick: checkPendingInvoices,
  },
  {
    name: 'delete-expired-invoices',
    cronTime: '0 */10 * * * *',
    runOnInit: false,
    tick: deleteExpiredInvoices,
  },
  {
    name: 'check-subscription-payments',
    cronTime: '0 */3 * * * *',
    runOnInit: false,
    tick: checkSubscriptionPayments,
  },
  {
    name: 'check-expired-subscriptions',
    cronTime: '0 0 * * * *',
    runOnInit: true,
    tick: checkExpiredSubscriptions,
  },
  {
    name: 'process-expiring-subscriptions',
    cronTime: '0 30 * * * *',
    runOnInit: true,
    tick: processExpiringSubscriptions,
  },
]

/** In-flight tick promises per job — used for graceful shutdown (step 10). */
const runningTicks = new Map<string, Promise<unknown>>()

const jobs = jobDefinitions.map(def =>
  CronJob.from({
    cronTime: def.cronTime,
    runOnInit: def.runOnInit,
    waitForCompletion: true,
    onTick: async () => {
      const tickPromise = Promise.resolve()
        .then(() => def.tick())
        .catch((error: unknown) => {
          logger.error({error, job: def.name}, 'Job tick failed')
        })
        .finally(() => {
          if (runningTicks.get(def.name) === tickPromise) {
            runningTicks.delete(def.name)
          }
        })
      runningTicks.set(def.name, tickPromise)
      await tickPromise
    },
  }),
)

export function startCronJobs(): void {
  for (const job of jobs) job.start()
  logger.info('Cron jobs started')
}

export function stopCronJobs(): void {
  for (const job of jobs) job.stop()
  logger.info('Cron jobs stopped')
}

/** Running tick promises (for shutdown drain). */
export function getRunningJobTicks(): Promise<unknown>[] {
  return [...runningTicks.values()]
}

export function getJobDefinitions(): readonly JobDefinition[] {
  return jobDefinitions
}
