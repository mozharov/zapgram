import {mock} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import type {DonationPaymentLookup} from '@core/money/donation-payment.js'
import type {NewPendingDonationPayment, PendingDonationPayment} from '@infra/db/types.js'
import {createDonationPayService, type DonationPayDeps} from './pay.service.js'
import {createPendingDonationService} from './pending.service.js'

/** Unit boundary: both wallet transports and persistence are supplied through deps. */
export function donationPayHarness() {
  const rows = new Map<string, PendingDonationPayment>()
  const ledger = new Map<string, {userId: number; amountSats: number; attemptId: string | null}>()
  const slots = new Map<string, string>()
  const log = {info: mock(() => {}), error: mock(() => {}), warn: mock(() => {})} as never
  const lookupFeePayment = mock(
    async (_hash: string): Promise<DonationPaymentLookup> => ({
      paid: false,
      status: 'pending',
      details: {amount: 50_000},
    }),
  )
  const savePending = async (row: NewPendingDonationPayment) => {
    rows.set(row.paymentHash, {...row, attemptId: row.attemptId ?? null, createdAt: new Date()})
  }
  const completePending = mock(async (hash: string) => {
    const row = rows.get(hash)
    if (!row) return
    if (!ledger.has(hash)) ledger.set(hash, row)
    rows.delete(hash)
  })
  const pending = createPendingDonationService({
    donations: {
      savePending,
      listPending: async (userId, kind) =>
        [...rows.values()].filter(
          row =>
            (userId === undefined || row.userId === userId) &&
            (kind === undefined || row.kind === kind),
        ),
      removePending: async hash => {
        rows.delete(hash)
      },
      completePending,
      findByAttempt: async (userId, attemptId) => {
        const entry = [...ledger].find(
          ([, row]) => row.userId === userId && row.attemptId === attemptId,
        )
        return entry
          ? {
              ...entry[1],
              paymentHash: entry[0],
              createdAt: new Date(),
              id: 'ledger',
              kind: 'one_shot' as const,
            }
          : undefined
      },
    },
    lookupFeePayment,
    log,
  })
  const payInvoice = mock(async (_invoice: string): Promise<{payment_hash?: string}> => ({}))
  const createFeeCollectionInvoice = mock(async (_sats: number) => ({
    payment_hash: `new-${createFeeCollectionInvoice.mock.calls.length}`,
    bolt11: 'invoice',
  }))
  const issuance: DonationPayDeps['issuance'] = {
    reserveIssuance: async (userId, kind, attemptId) => {
      const key = JSON.stringify([userId, kind, attemptId])
      if (slots.has(key)) return null
      const token = crypto.randomUUID()
      slots.set(key, token)
      return {
        key,
        token,
        rows: [...rows.values()].filter(
          row =>
            row.userId === userId &&
            row.kind === kind &&
            (kind !== 'feature_request' || attemptId === undefined || row.attemptId === attemptId),
        ),
      }
    },
    releaseIssuance: async slot => {
      if (slots.get(slot.key) === slot.token) slots.delete(slot.key)
    },
    saveIssued: async (slot, row) => {
      if (slots.get(slot.key) !== slot.token) return false
      await savePending(row)
      return true
    },
  }
  const deps: DonationPayDeps = {
    pending,
    issuance,
    createFeeCollectionInvoice,
    getUserWallet: async () => ({balance: 100_000, payInvoice}),
    insertDonation: async () => {
      throw new Error('Explicit payments must complete pending atomically')
    },
    log,
  }
  const service = createDonationPayService(deps)
  const save = (
    paymentHash = 'previous',
    attemptId: string | null = null,
    expiresAt = new Date(Date.now() + 60_000),
  ) =>
    pending.save({
      userId: 1,
      kind: attemptId ? 'feature_request' : 'one_shot',
      attemptId,
      paymentHash,
      amountSats: 50,
      expiresAt,
    })
  const uncertain = () => payInvoice.mockRejectedValue(new NWCPaymentFailedError())
  const insufficient = () => payInvoice.mockRejectedValue(new InsufficientFundsError())
  return {
    service,
    deps,
    pending,
    issuance,
    rows,
    ledger,
    slots,
    save,
    uncertain,
    insufficient,
    completePending,
    lookupFeePayment,
    payInvoice,
    createFeeCollectionInvoice,
    log,
  }
}
