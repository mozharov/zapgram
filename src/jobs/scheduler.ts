import {sleep} from '@core/utils/sleep.js'
import type {AppLogger} from '@infra/logger.js'
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

export type Scheduler = {
  start: () => void
  /**
   * Stops scheduling new ticks, then waits for in-flight ticks to finish
   * (or until drainTimeoutMs), so a settle mid-flight is not force-killed.
   */
  stop: (opts?: {drainTimeoutMs?: number}) => Promise<{drained: boolean}>
  getRunningTicks: () => Promise<unknown>[]
}

export function defaultJobDefinitions(): JobDefinition[] {
  return [
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
}

export function createScheduler(
  jobDefinitions: JobDefinition[] = defaultJobDefinitions(),
  log: AppLogger,
): Scheduler {
  /** In-flight tick promises per job — drained on stop for graceful shutdown. */
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
            log.error({error, job: def.name}, 'Job tick failed')
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

  return {
    start() {
      for (const job of jobs) job.start()
      log.info('Cron jobs started')
    },

    async stop({drainTimeoutMs = 10_000} = {}) {
      for (const job of jobs) job.stop()
      log.info('Cron jobs stopped; draining in-flight ticks...')

      const ticks = [...runningTicks.values()]
      if (ticks.length === 0) {
        log.info('No in-flight job ticks to drain')
        return {drained: true}
      }

      const outcome = await Promise.race([
        Promise.allSettled(ticks).then(() => 'drained' as const),
        sleep(drainTimeoutMs).then(() => 'timeout' as const),
      ])

      if (outcome === 'timeout') {
        log.error(
          {remaining: runningTicks.size, drainTimeoutMs},
          'Timed out waiting for job ticks to finish',
        )
        return {drained: false}
      }

      log.info('In-flight job ticks drained')
      return {drained: true}
    },

    getRunningTicks() {
      return [...runningTicks.values()]
    },
  }
}

export function getJobDefinitions(): readonly JobDefinition[] {
  return defaultJobDefinitions()
}
