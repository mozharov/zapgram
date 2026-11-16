import {expect, test} from 'bun:test'
import {runDmTransferRecovery} from './recover-dm-transfers.js'

test('a page of in-flight rows does not hide a later notice', async () => {
  const seen: string[] = []
  const rows = [...Array.from({length: 20}, (_, index) => `stuck-${index}`), 'notice']
  await runDmTransferRecovery({
    list: async (limit, offset) => rows.slice(offset, offset + limit).map(id => ({id})),
    reconcile: async id => {
      seen.push(id)
      return id === 'notice' ? 'settled' : 'in_flight'
    },
    log: {error() {}},
  })
  expect(seen).toContain('notice')
})

test('review rows that remain actionable are processed once and do not hide later rows', async () => {
  const rows = Array.from({length: 45}, (_, index) => `review-${index}`)
  const seen: string[] = []
  await runDmTransferRecovery({
    list: async (limit, offset) => rows.slice(offset, offset + limit).map(id => ({id})),
    reconcile: async id => {
      seen.push(id)
      return 'needs_review'
    },
    log: {error() {}},
  })
  expect(seen).toEqual(rows)
})
