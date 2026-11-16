import {expect, mock, test} from 'bun:test'
import type {DonationPaymentLookup} from '@core/money/donation-payment.js'
import type {PendingDonationPayment} from '@infra/db/types.js'
import {HTTPError} from 'got'
import {createPendingDonationService} from './pending.service.js'

function harness() {
  const now = new Date()
  const rows: PendingDonationPayment[] = []
  const ledger = new Map<string, number>()
  const completePending = mock(async (hash: string) => {
    const index = rows.findIndex(row => row.paymentHash === hash)
    const row = rows[index]
    if (!row) return
    if (!ledger.has(hash)) ledger.set(hash, row.amountSats)
    rows.splice(index, 1)
  })
  const removePending = mock(async (hash: string) => {
    const index = rows.findIndex(row => row.paymentHash === hash)
    if (index >= 0) rows.splice(index, 1)
  })
  const lookupFeePayment = mock(
    async (_hash: string): Promise<DonationPaymentLookup> => ({
      paid: false,
      status: 'pending',
      details: {amount: 50_000},
    }),
  )
  const log = {info: mock(() => {}), error: mock(() => {})} as never
  const service = createPendingDonationService({
    donations: {
      savePending: async row => {
        rows.push({...row, createdAt: now})
      },
      listPending: async (userId, kind) =>
        rows.filter(
          row =>
            (userId === undefined || row.userId === userId) &&
            (kind === undefined || row.kind === kind),
        ),
      completePending,
      removePending,
    },
    lookupFeePayment,
    log,
  })
  const save = (
    paymentHash = 'hash',
    kind: PendingDonationPayment['kind'] = 'one_shot',
    expiresAt = new Date(now.getTime() + 60_000),
  ) => service.save({userId: 1, paymentHash, kind, amountSats: 50, expiresAt})
  return {now, rows, ledger, completePending, removePending, lookupFeePayment, service, save}
}

for (const outcome of [
  'paid',
  'failed',
  '404',
  'expired',
  'ttl',
  'live',
  'timeout',
  '401',
  '500',
] as const) {
  test(`pending reconciliation: ${outcome}`, async () => {
    const h = harness()
    await h.save()
    if (outcome === 'paid')
      h.lookupFeePayment.mockResolvedValue({
        paid: true,
        details: {amount: 50_000, expiry: new Date(h.now.getTime() - 1000)},
      })
    if (outcome === 'failed')
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        status: 'failed',
        details: {amount: 50_000},
      })
    if (outcome === 'expired')
      h.lookupFeePayment.mockResolvedValue({
        paid: false,
        status: 'pending',
        details: {amount: 50_000, expiry: new Date(h.now.getTime() - 1000)},
      })
    if (outcome === '404' || outcome === '401' || outcome === '500')
      h.lookupFeePayment.mockRejectedValue(
        Object.assign(Object.create(HTTPError.prototype), {
          response: {statusCode: Number(outcome)},
        }),
      )
    if (outcome === 'timeout') h.lookupFeePayment.mockRejectedValue(new Error('timeout'))
    const now = outcome === 'ttl' ? new Date(h.now.getTime() + 60_001) : h.now
    await h.service.reconcileAll(now)
    const pending = ['live', 'timeout', '401', '500'].includes(outcome)
    expect(h.rows).toHaveLength(pending ? 1 : 0)
    expect(h.ledger.size).toBe(outcome === 'paid' ? 1 : 0)
    expect(h.lookupFeePayment).toHaveBeenCalledWith('hash')
    expect(h.completePending).toHaveBeenCalledTimes(outcome === 'paid' ? 1 : 0)
    expect(h.removePending).toHaveBeenCalledTimes(!pending && outcome !== 'paid' ? 1 : 0)
  })
}

test('user reconciliation filters by kind and preserves independent percent hashes', async () => {
  const h = harness()
  await h.save('tip-a', 'percent')
  await h.save('tip-b', 'percent')
  await h.save('feature', 'feature_request')
  h.lookupFeePayment.mockImplementation(async hash => ({
    paid: hash === 'tip-a',
    details: {amount: 50_000},
  }))
  const results = await h.service.reconcileUser(1, 'percent')
  expect(results.map(item => item.state)).toEqual(['paid', 'pending'])
  expect(h.rows.map(row => row.paymentHash)).toEqual(['tip-b', 'feature'])
  expect(h.ledger.get('tip-a')).toBe(50)
  expect(h.lookupFeePayment).toHaveBeenCalledTimes(2)
})

test('lookup errors report pending to UI and do not remove hashes', async () => {
  const h = harness()
  await h.save()
  h.lookupFeePayment.mockRejectedValue(new Error('timeout'))
  expect((await h.service.reconcileUser(1, 'one_shot'))[0]?.state).toBe('pending')
  expect(h.rows).toHaveLength(1)
  expect(h.completePending).not.toHaveBeenCalled()
  expect(h.removePending).not.toHaveBeenCalled()
})

test('a ledger error preserves its pending row and does not stop reconciliation of another row', async () => {
  const h = harness()
  await h.save('first')
  await h.save('second')
  h.lookupFeePayment.mockResolvedValue({paid: true, details: {amount: 50_000}})
  h.completePending.mockRejectedValueOnce(new Error('ledger unavailable'))
  await h.service.reconcileAll()
  expect(h.rows.map(row => row.paymentHash)).toEqual(['first'])
  expect(h.ledger.has('second')).toBe(true)
  await h.service.reconcileAll()
  expect(h.rows).toHaveLength(0)
  expect(h.ledger.size).toBe(2)
})
