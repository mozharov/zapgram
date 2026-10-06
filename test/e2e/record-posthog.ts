import type {E2E} from './harness.js'

export type RecordedCapture = {
  event: string
  distinctId?: string
  properties?: Record<string, unknown>
}

/** Replace the world's PostHog client with one that records capture payloads. */
export function recordPosthog(e2e: E2E): RecordedCapture[] {
  const events: RecordedCapture[] = []
  e2e.container.posthog = {
    capture({event, distinctId, properties}: RecordedCapture) {
      events.push({event, distinctId, properties})
    },
    captureException() {},
    groupIdentify() {},
    alias() {},
    async shutdown() {},
    withContext(_data: unknown, fn: () => unknown) {
      return fn()
    },
  } as unknown as E2E['container']['posthog']
  return events
}

export function capturesOf(events: RecordedCapture[], event: string): RecordedCapture[] {
  return events.filter(item => item.event === event)
}
