import {classifyDonationLookup, type DonationPaymentLookup} from '@core/money/donation-payment.js'
import type {NewPendingDonationPayment, PendingDonationPayment} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import {HTTPError} from 'got'
import type {DonationRepository} from './repository.js'

export function createPendingDonationService(deps: {
  donations: Pick<
    DonationRepository,
    'savePending' | 'listPending' | 'removePending' | 'completePending' | 'findByAttempt'
  >
  lookupFeePayment: (hash: string) => Promise<DonationPaymentLookup>
  log: AppLogger
}) {
  async function reconcile(row: PendingDonationPayment, now = new Date()) {
    let state: 'paid' | 'pending' | 'retryable'
    try {
      state = classifyDonationLookup(
        await deps.lookupFeePayment(row.paymentHash),
        row.expiresAt,
        now,
      )
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) state = 'retryable'
      else throw error
    }
    if (state === 'paid') await deps.donations.completePending(row.paymentHash)
    else if (state === 'retryable') await deps.donations.removePending(row.paymentHash)
    if (state !== 'pending')
      deps.log.info(
        {userId: row.userId, paymentHash: row.paymentHash, state},
        'Pending donation reconciled',
      )
    return state
  }

  async function reconcileSafely(row: PendingDonationPayment, now = new Date()) {
    try {
      return await reconcile(row, now)
    } catch (error) {
      deps.log.error(
        {error, userId: row.userId, paymentHash: row.paymentHash},
        'Pending donation reconciliation failed',
      )
      // Keep the hash on lookup or ledger errors. A distinct percent collection may still proceed.
      return 'pending' as const
    }
  }

  async function reconcileUser(
    userId: number,
    kind: PendingDonationPayment['kind'],
    attemptId?: string,
    observed: PendingDonationPayment[] = [],
  ) {
    if (kind === 'feature_request' && attemptId !== undefined) {
      const paid = await deps.donations.findByAttempt(userId, attemptId)
      if (paid?.paymentHash)
        return [
          {
            state: 'paid' as const,
            row: {
              paymentHash: paid.paymentHash,
              userId,
              kind,
              attemptId,
              amountSats: paid.amountSats,
              createdAt: paid.createdAt,
              expiresAt: paid.createdAt,
            },
          },
        ]
    }
    const results = []
    // Keep the transactional snapshot even if cron removed a paid row during our lookup.
    const rows = new Map(observed.map(row => [row.paymentHash, row]))
    for (const row of await deps.donations.listPending(userId, kind)) rows.set(row.paymentHash, row)
    for (const row of rows.values()) {
      if (kind === 'feature_request' && attemptId !== undefined && row.attemptId !== attemptId)
        continue
      results.push({row, state: await reconcileSafely(row)})
    }
    return results
  }

  async function reconcileAll(now = new Date()) {
    for (const row of await deps.donations.listPending()) {
      await reconcileSafely(row, now)
    }
  }

  async function save(input: NewPendingDonationPayment) {
    await deps.donations.savePending(input)
    deps.log.info(
      {userId: input.userId, paymentHash: input.paymentHash, kind: input.kind},
      'Pending donation saved',
    )
  }

  return {
    save,
    reconcileUser,
    reconcileAll,
    complete: deps.donations.completePending,
    remove: deps.donations.removePending,
  }
}

export type PendingDonationService = ReturnType<typeof createPendingDonationService>
