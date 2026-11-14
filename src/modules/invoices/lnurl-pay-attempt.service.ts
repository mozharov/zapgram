import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {LnurlPayAttempt} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {LnurlPayAttemptRepository} from './lnurl-pay-attempt.repository.js'

/** An unknown pay is not retried. After this it is logged once for a person. */
export const LNURL_PAY_REVIEW_MS = 24 * 60 * 60_000
/** A saved invoice that was never submitted is abandoned after this. */
export const LNURL_INVOICE_GRACE_MS = 2 * 60_000

export type LnurlPayGate = 'ready' | 'blocked' | 'in_flight' | 'paid'

type Rail = 'internal' | 'nwc'

export type LnurlPayAttemptDeps = {
  attempts: LnurlPayAttemptRepository
  log: AppLogger
  now?: () => Date
  invoiceGraceMs?: number
  payReviewMs?: number
  lookup: (
    userId: number,
    hash: string,
    bolt11: string,
    rail: Rail,
  ) => Promise<PayoutState | 'unknown'>
  notifySender?: (input: {
    fromUserId: number
    recipient: string
    sats: number
    outcome: 'settled' | 'abandoned'
  }) => Promise<boolean>
  collectDonation?: (input: {userId: number; sats: number; rail: Rail}) => Promise<void>
}

/**
 * One LNURL invoice, one debit.
 *
 * `beginPay` writes the payment hash and flips the row to `pay_unknown` before
 * the wallet is called. A timeout leaves that row. A later Send to the same
 * recipient does not mint or pay another invoice while it is unresolved.
 */
export function createLnurlPayAttemptService(deps: LnurlPayAttemptDeps) {
  const now = () => deps.now?.() ?? new Date()
  const graceMs = deps.invoiceGraceMs ?? LNURL_INVOICE_GRACE_MS
  const reviewMs = deps.payReviewMs ?? LNURL_PAY_REVIEW_MS

  async function hasUnresolved(fromUserId: number, recipient: string): Promise<boolean> {
    const open = await deps.attempts.findOpen(fromUserId, recipient)
    return open !== undefined
  }

  async function beginPay(input: {
    attemptId: string
    fromUserId: number
    recipient: string
    sats: number
    rail: Rail
    paymentHash: string
    bolt11: string
  }): Promise<LnurlPayGate> {
    const open = await deps.attempts.findOpen(input.fromUserId, input.recipient)
    if (open && open.id !== input.attemptId) return 'blocked'

    const row = await deps.attempts.reserve({
      id: input.attemptId,
      fromUserId: input.fromUserId,
      recipient: input.recipient,
      sats: input.sats,
      rail: input.rail,
      createdAt: now(),
    })
    if (row.fromUserId !== input.fromUserId || row.recipient !== input.recipient) {
      return 'blocked'
    }
    if (row.sats !== input.sats) return 'blocked'
    if (row.status === 'settled' || row.phase === 'provider_accepted' || row.providerAccepted) {
      return 'paid'
    }
    if (row.phase === 'pay_unknown' || row.phase === 'needs_review') return 'in_flight'
    if (row.phase === 'abandoned') return 'blocked'

    const saved = await deps.attempts.saveInvoice(row.id, row.invoiceHash, {
      hash: input.paymentHash,
      bolt11: input.bolt11,
    })
    if (!saved) return 'in_flight'
    try {
      const claimed = await deps.attempts.markPhase(saved.id, 'pay_unknown', 'invoice_saved')
      if (!claimed) return 'in_flight'
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (!code.includes('CONSTRAINT')) throw error
      deps.log.info({recipient: input.recipient}, 'LNURL pay attempt blocked by an open one')
      return 'blocked'
    }
    return 'ready'
  }

  async function notePaid(id: string, paymentHash?: string) {
    const before = await deps.attempts.get(id)
    await deps.attempts.markProviderAccepted(id, paymentHash)
    await deps.attempts.markSettled(id)
    const row = await deps.attempts.get(id)
    if (row.status !== 'settled') return
    await tellSender(row, 'settled')
    if (before.status === 'settled' || !deps.collectDonation) return
    await deps
      .collectDonation({userId: row.fromUserId, sats: row.sats, rail: row.rail})
      .catch(error => {
        deps.log.error({error, attemptId: row.id}, 'LNURL pay donation failed')
      })
  }

  async function noteRejected(id: string) {
    await deps.attempts.markAbandoned(id)
  }

  async function reconcile(
    id: string,
  ): Promise<'settled' | 'abandoned' | 'in_flight' | 'needs_review'> {
    const row = await deps.attempts.get(id)
    if (row.phase === 'abandoned') {
      await tellSender(row, 'abandoned')
      return 'abandoned'
    }
    if (row.status === 'settled') {
      await tellSender(row, 'settled')
      return 'settled'
    }
    if (row.providerAccepted || row.phase === 'provider_accepted') {
      await notePaid(row.id, row.providerPaymentHash ?? undefined)
      return 'settled'
    }
    if (!row.invoiceHash || row.phase === 'reserved' || row.phase === 'invoice_saved') {
      if (ageMs(row) > graceMs) {
        await deps.attempts.markAbandoned(row.id)
        await tellSender(row, 'abandoned')
        return 'abandoned'
      }
      return 'in_flight'
    }
    const state = await lookupQuiet(row)
    if (state === 'paid') {
      await notePaid(row.id, row.providerPaymentHash ?? undefined)
      const latest = await deps.attempts.get(id)
      return latest.status === 'settled' ? 'settled' : 'in_flight'
    }
    if (state === 'retryable' && ageMs(row) > reviewMs) {
      await deps.attempts.markAbandoned(row.id)
      await tellSender(row, 'abandoned')
      deps.log.error(
        {attemptId: row.id},
        'LNURL pay abandoned after the provider reported no payment',
      )
      return 'abandoned'
    }
    if (row.phase === 'needs_review') return 'in_flight'
    if ((state === 'pending' || state === 'unknown') && ageMs(row) > reviewMs) {
      const logged = await deps.attempts.markNeedsReview(row.id)
      if (logged) {
        deps.log.error(
          {attemptId: row.id},
          'LNURL pay needs a person: the outcome is still unknown',
        )
      }
      return 'needs_review'
    }
    return 'in_flight'
  }

  async function tellSender(row: LnurlPayAttempt, outcome: 'settled' | 'abandoned') {
    if (!deps.notifySender || row.senderNotified) return
    const claimed = await deps.attempts.claimSenderNotice(row.id)
    if (!claimed) return
    try {
      const sent = await deps.notifySender({
        fromUserId: row.fromUserId,
        recipient: row.recipient,
        sats: row.sats,
        outcome,
      })
      if (!sent) await deps.attempts.releaseSenderNotice(row.id)
    } catch (error) {
      await deps.attempts.releaseSenderNotice(row.id)
      deps.log.error({error, attemptId: row.id}, 'LNURL pay sender notice failed')
    }
  }

  async function lookupQuiet(row: LnurlPayAttempt): Promise<PayoutState | 'unknown'> {
    if (!row.invoiceHash) return 'unknown'
    try {
      return await deps.lookup(row.fromUserId, row.invoiceHash, row.bolt11 ?? '', row.rail)
    } catch (error) {
      deps.log.info(
        {name: error instanceof Error ? error.name : 'unknown'},
        'LNURL pay lookup failed',
      )
      return 'unknown'
    }
  }

  function ageMs(row: LnurlPayAttempt): number {
    return now().getTime() - row.createdAt.getTime()
  }

  function isClearMiss(error: unknown): boolean {
    return error instanceof InsufficientFundsError
  }

  function isAlreadyPaid(error: unknown): boolean {
    return error instanceof InvoiceAlreadyPaidError
  }

  return {
    hasUnresolved,
    beginPay,
    notePaid,
    noteRejected,
    reconcile,
    isClearMiss,
    isAlreadyPaid,
    listActionable: (limit: number, offset: number) => deps.attempts.listActionable(limit, offset),
  }
}

export type LnurlPayAttemptService = ReturnType<typeof createLnurlPayAttemptService>
