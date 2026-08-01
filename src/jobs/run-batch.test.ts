import {describe, expect, test} from 'bun:test'
import {runBatch} from './run-batch.js'

function silentLog() {
  return {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}}
}

describe('runBatch', () => {
  test('mixed done/keep advances offset only by survivors', async () => {
    // Simulate a queue: deleting even ids shifts remaining left.
    let queue = [1, 2, 3, 4, 5, 6]
    const seen: number[] = []

    const result = await runBatch({
      name: 'items',
      log: silentLog(),
      batchSize: 2,
      count: async () => queue.length,
      fetch: async (limit, offset) => queue.slice(offset, offset + limit),
      process: async item => {
        seen.push(item)
        if (item % 2 === 0) {
          queue = queue.filter(x => x !== item)
          return 'done'
        }
        return 'keep'
      },
    })

    expect(result.processed).toBeGreaterThanOrEqual(6)
    // Every original item must be seen; none skipped due to bad offset math.
    expect(new Set(seen)).toEqual(new Set([1, 2, 3, 4, 5, 6]))
    // Odds remain (kept), evens removed.
    expect(queue).toEqual([1, 3, 5])
  })

  test('empty fetch ends the loop', async () => {
    let fetchCalls = 0
    const result = await runBatch({
      name: 'empty',
      log: silentLog(),
      count: async () => 5, // count lies; fetch is empty
      fetch: async () => {
        fetchCalls++
        return []
      },
      process: async () => 'done',
    })
    expect(result.processed).toBe(0)
    expect(fetchCalls).toBe(1)
  })

  test('error in process does not abort the batch and counts as keep', async () => {
    const items = [1, 2, 3]
    const seen: number[] = []
    const errors: unknown[] = []

    await runBatch({
      name: 'faulty',
      log: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (obj: unknown) => {
          errors.push(obj)
        },
      },
      batchSize: 10,
      count: async () => items.length,
      fetch: async (limit, offset) => items.slice(offset, offset + limit),
      process: async item => {
        seen.push(item)
        if (item === 2) throw new Error('boom')
        return 'keep'
      },
    })

    expect(seen).toEqual([1, 2, 3])
    expect(errors.length).toBe(1)
  })

  test('count zero skips fetch', async () => {
    let fetched = false
    const result = await runBatch({
      name: 'none',
      log: silentLog(),
      count: async () => 0,
      fetch: async () => {
        fetched = true
        return []
      },
      process: async () => 'done',
    })
    expect(result.processed).toBe(0)
    expect(fetched).toBe(false)
  })
})
