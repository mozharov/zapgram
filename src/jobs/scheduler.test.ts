import {describe, expect, test} from 'bun:test'
import {createScheduler, JOB_ANALYTICS_DISTINCT_ID, type JobDefinition} from './scheduler.js'

function silentLog() {
  return {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}}
}

describe('createScheduler', () => {
  test('stop() resolves only after the current tick finishes', async () => {
    let resolveTick!: () => void
    const tickStarted = Promise.withResolvers<void>()
    const tickGate = new Promise<void>(resolve => {
      resolveTick = resolve
    })

    let tickFinished = false
    const jobs: JobDefinition[] = [
      {
        name: 'slow-job',
        // every second — we will trigger via runOnInit
        cronTime: '0 0 0 1 1 *', // effectively never in practice
        runOnInit: true,
        tick: async () => {
          tickStarted.resolve()
          await tickGate
          tickFinished = true
        },
      },
    ]

    const scheduler = createScheduler(jobs, silentLog())
    scheduler.start()

    await tickStarted.promise
    expect(tickFinished).toBe(false)
    expect(scheduler.getRunningTicks()).toHaveLength(1)

    // Unblock the tick shortly after stop begins draining
    setTimeout(() => resolveTick(), 30)

    const stopStarted = Date.now()
    const {drained} = await scheduler.stop({drainTimeoutMs: 5000})
    const elapsed = Date.now() - stopStarted

    expect(drained).toBe(true)
    expect(tickFinished).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(20)
    expect(scheduler.getRunningTicks()).toHaveLength(0)
  })

  test('stop() times out if a tick never finishes', async () => {
    const tickStarted = Promise.withResolvers<void>()
    const jobs: JobDefinition[] = [
      {
        name: 'stuck-job',
        cronTime: '0 0 0 1 1 *',
        runOnInit: true,
        tick: async () => {
          tickStarted.resolve()
          await new Promise(() => {}) // never resolves
        },
      },
    ]

    const scheduler = createScheduler(jobs, silentLog())
    scheduler.start()
    await tickStarted.promise

    const {drained} = await scheduler.stop({drainTimeoutMs: 50})
    expect(drained).toBe(false)
  })

  test('successful ticks do not emit PostHog analytics', async () => {
    const exceptions: unknown[] = []
    const tickStarted = Promise.withResolvers<void>()
    const jobs: JobDefinition[] = [
      {
        name: 'ok-job',
        cronTime: '0 0 0 1 1 *',
        runOnInit: true,
        tick: async () => {
          tickStarted.resolve()
        },
      },
    ]

    const scheduler = createScheduler(jobs, silentLog(), {
      captureException: error => {
        exceptions.push(error)
      },
    })
    scheduler.start()
    await tickStarted.promise
    await scheduler.stop({drainTimeoutMs: 1000})

    expect(exceptions).toEqual([])
  })

  test('failed ticks captureException with job metadata', async () => {
    const exceptions: Array<{error: unknown; distinctId?: string; properties?: unknown}> = []
    const tickStarted = Promise.withResolvers<void>()
    const boom = new Error('tick exploded')
    const jobs: JobDefinition[] = [
      {
        name: 'fail-job',
        cronTime: '0 0 0 1 1 *',
        runOnInit: true,
        tick: async () => {
          tickStarted.resolve()
          throw boom
        },
      },
    ]

    const scheduler = createScheduler(jobs, silentLog(), {
      captureException: (error, distinctId, properties) => {
        exceptions.push({error, distinctId, properties})
      },
    })
    scheduler.start()
    await tickStarted.promise
    await scheduler.stop({drainTimeoutMs: 1000})

    expect(exceptions).toEqual([
      {
        error: boom,
        distinctId: JOB_ANALYTICS_DISTINCT_ID,
        properties: {
          job: 'fail-job',
          duration_ms: expect.any(Number),
          $process_person_profile: false,
        },
      },
    ])
  })
})
