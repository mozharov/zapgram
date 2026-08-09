import {describe, expect, test} from 'bun:test'
import {createRateService} from './rate-service.js'

describe('createRateService', () => {
  test('returns fetched rate and serves cache within TTL', async () => {
    let calls = 0
    const now = 1_000
    const rates = createRateService({
      fetchUsdBtcRate: async () => {
        calls++
        return 50_000
      },
      ttlMs: 60_000,
      now: () => now,
    })
    expect(await rates.getBtcUsd()).toBe(50_000)
    expect(await rates.getBtcUsd()).toBe(50_000)
    expect(calls).toBe(1)
  })

  test('refetches after TTL', async () => {
    let calls = 0
    let now = 1_000
    const rates = createRateService({
      fetchUsdBtcRate: async () => {
        calls++
        return 40_000 + calls
      },
      ttlMs: 60_000,
      now: () => now,
    })
    expect(await rates.getBtcUsd()).toBe(40_001)
    now = 1_000 + 60_001
    expect(await rates.getBtcUsd()).toBe(40_002)
    expect(calls).toBe(2)
  })

  test('on fetch fail with last-good, returns last-good', async () => {
    let fail = false
    let now = 1_000
    const rates = createRateService({
      fetchUsdBtcRate: async () => {
        if (fail) throw new Error('down')
        return 42_000
      },
      ttlMs: 1,
      now: () => now,
      log: {error: () => {}, warn: () => {}},
    })
    expect(await rates.getBtcUsd()).toBe(42_000)
    fail = true
    now = 5_000
    expect(await rates.getBtcUsd()).toBe(42_000)
  })

  test('on cold fail returns null', async () => {
    const rates = createRateService({
      fetchUsdBtcRate: async () => {
        throw new Error('down')
      },
      log: {error: () => {}},
    })
    expect(await rates.getBtcUsd()).toBeNull()
  })

  test('coalesces concurrent refreshes', async () => {
    let calls = 0
    let resolveFetch!: (n: number) => void
    const rates = createRateService({
      fetchUsdBtcRate: () =>
        new Promise(resolve => {
          calls++
          resolveFetch = resolve
        }),
    })
    const a = rates.getBtcUsd()
    const b = rates.getBtcUsd()
    resolveFetch(55_000)
    expect(await a).toBe(55_000)
    expect(await b).toBe(55_000)
    expect(calls).toBe(1)
  })
})
