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
/**
 * A wallet clock this far behind the attempt row still counts as this debit.
 * Anything older was paid before this attempt existed.
 */
export const LNURL_PAY_CLOCK_SKEW_MS = 15_000

export type LnurlPayLookup = {
  state: PayoutState | 'unknown'
  /** When the wallet settled the outgoing payment, if it said. */
  paidAt?: Date
}

export type LnurlPayGate = 'ready' | 'blocked' | 'in_flight' | 'paid'

type Rail = 'internal' | 'nwc'

export type LnurlPayAttemptDeps = {
  attempts: LnurlPayAttemptRepository
  log: AppLogger
  now?: () => Date
  invoiceGraceMs?: number
  payReviewMs?: number
  lookup: (userId: number, hash: string, bolt11: string, rail: Rail) => Promise<LnurlPayLookup>
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

  async function notePaid(
    id: string,
    paymentHash?: string,
    senderNotified = false,
  ): Promise<boolean> {
    const before = await deps.attempts.get(id)
    if (before.status === 'settled') return true
    const hash = paymentHash ?? before.invoiceHash ?? undefined
    if (hash && (await deps.attempts.findSettledByHash(hash, id))) {
      await deps.attempts.dropUnclaimed(id)
      return false
    }
    try {
      await deps.attempts.markProviderAccepted(id, paymentHash)
      // The wizard's receipt claims the sender in this same settle, so recovery
      // cannot send a second message while the screen is still being painted.
      await deps.attempts.markSettled(id, senderNotified)
    } catch (error) {
      if (!isConstraint(error)) throw error
      await deps.attempts.dropUnclaimed(id)
      return false
    }
    const row = await deps.attempts.get(id)
    if (row.status !== 'settled') return false
    // The wizard shows the receipt itself. Recovery is what tells the sender
    // when that screen never landed.
    if (!deps.collectDonation) return true
    await deps
      .collectDonation({userId: row.fromUserId, sats: row.sats, rail: row.rail})
      .catch(error => {
        deps.log.error({error, attemptId: row.id}, 'LNURL pay donation failed')
      })
    return true
  }

  async function noteRejected(id: string) {
    await deps.attempts.markAbandoned(id)
  }

  /**
   * "Already paid" means the invoice is settled, not that this attempt paid it.
   * A payment that settled before this row, or one another attempt already
   * claimed, is not a receipt and does not collect another donation.
   */
  async function resolveAlreadyPaid(id: string): Promise<'paid' | 'hold' | 'absent'> {
    const row = await deps.attempts.get(id)
    const looked = await lookupQuiet(row)
    if (looked.state === 'paid') return finishPaidLookup(row, looked, 'wizard')
    if (looked.state === 'pending' || looked.state === 'unknown') return 'hold'
    await noteRejected(id)
    return 'absent'
  }

  /**
   * What a paid lookup means for this attempt.
   * `fresh` — the wallet does not have a settled payment yet, so a following pay is this debit.
   */
  async function readPay(
    id: string,
  ): Promise<'fresh' | 'prior' | 'ours' | 'unknown' | 'ambiguous'> {
    const row = await deps.attempts.get(id)
    const looked = await lookupQuiet(row)
    if (looked.state === 'paid') return claimOf(row, looked)
    if (looked.state === 'pending' || looked.state === 'retryable') return 'fresh'
    return 'unknown'
  }

  async function reconcile(
    id: string,
  ): Promise<'settled' | 'abandoned' | 'in_flight' | 'needs_review'> {
    const row = await deps.attempts.get(id)
    if (row.phase === 'abandoned') {
      await tellSender(row, 'abandoned')
      return 'abandoned'
    }
    if (row.status === 'settled') return finishSender(row)
    if (row.providerAccepted || row.phase === 'provider_accepted') {
      const claimed = await notePaid(
        row.id,
        row.providerPaymentHash ?? row.invoiceHash ?? undefined,
      )
      if (!claimed) {
        await tellSender(row, 'abandoned')
        return 'abandoned'
      }
      return finishSender(await deps.attempts.get(id))
    }
    if (!row.invoiceHash || row.phase === 'reserved' || row.phase === 'invoice_saved') {
      if (ageMs(row) > graceMs) {
        await deps.attempts.markAbandoned(row.id)
        await tellSender(row, 'abandoned')
        return 'abandoned'
      }
      return 'in_flight'
    }
    const looked = await lookupQuiet(row)
    if (looked.state === 'paid') {
      const claim = await finishPaidLookup(row, looked, 'recover')
      if (claim === 'hold') return 'in_flight'
      if (claim === 'absent') return 'abandoned'
      return finishSender(await deps.attempts.get(id))
    }
    if (looked.state === 'retryable' && ageMs(row) > reviewMs) {
      await deps.attempts.markAbandoned(row.id)
      await tellSender(row, 'abandoned')
      deps.log.error(
        {attemptId: row.id},
        'LNURL pay abandoned after the provider reported no payment',
      )
      return 'abandoned'
    }
    if (row.phase === 'needs_review') return 'in_flight'
    if ((looked.state === 'pending' || looked.state === 'unknown') && ageMs(row) > reviewMs) {
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

  async function finishSender(row: LnurlPayAttempt): Promise<'settled' | 'in_flight'> {
    if (row.status !== 'settled') return 'in_flight'
    await tellSender(row, 'settled')
    const latest = await deps.attempts.get(row.id)
    return latest.senderNotified ? 'settled' : 'in_flight'
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

  async function finishPaidLookup(
    row: LnurlPayAttempt,
    looked: LnurlPayLookup,
    mode: 'wizard' | 'recover',
  ): Promise<'paid' | 'hold' | 'absent'> {
    const claim = await claimOf(row, looked)
    if (claim === 'ours') {
      // The wizard paints the receipt itself. Recovery sends it afterwards.
      const claimed = await notePaid(row.id, row.invoiceHash ?? undefined, mode === 'wizard')
      return claimed ? 'paid' : 'absent'
    }
    if (claim === 'prior') {
      await deps.attempts.dropUnclaimed(row.id)
      if (mode === 'recover') await tellSender(row, 'abandoned')
      return 'absent'
    }
    return 'hold'
  }

  async function claimOf(
    row: LnurlPayAttempt,
    looked: LnurlPayLookup,
  ): Promise<'ours' | 'prior' | 'ambiguous'> {
    if (row.invoiceHash && (await deps.attempts.findSettledByHash(row.invoiceHash, row.id))) {
      return 'prior'
    }
    if (paymentIsPrior(row.createdAt, looked.paidAt)) return 'prior'
    if (looked.paidAt) return 'ours'
    return 'ambiguous'
  }

  async function lookupQuiet(row: LnurlPayAttempt): Promise<LnurlPayLookup> {
    if (!row.invoiceHash) return {state: 'unknown'}
    try {
      return await deps.lookup(row.fromUserId, row.invoiceHash, row.bolt11 ?? '', row.rail)
    } catch (error) {
      deps.log.info(
        {name: error instanceof Error ? error.name : 'unknown'},
        'LNURL pay lookup failed',
      )
      return {state: 'unknown'}
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

  function isConstraint(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return code.includes('CONSTRAINT')
  }

  return {
    hasUnresolved,
    beginPay,
    notePaid,
    noteRejected,
    readPay,
    resolveAlreadyPaid,
    reconcile,
    isClearMiss,
    isAlreadyPaid,
    /** The receipt is on screen. Recovery must not send a second success message. */
    markSenderNotified: (id: string) => deps.attempts.claimSenderNotice(id),
    releaseSenderNotice: (id: string) => deps.attempts.releaseSenderNotice(id),
    listActionable: (limit: number, offset: number) => deps.attempts.listActionable(limit, offset),
  }
}

export type LnurlPayAttemptService = ReturnType<typeof createLnurlPayAttemptService>

/** A settled payment older than this attempt is an earlier debit, not this one. */
export function paymentIsPrior(attemptCreatedAt: Date, paidAt: Date | undefined): boolean {
  if (!paidAt) return false
  return paidAt.getTime() < attemptCreatedAt.getTime() - LNURL_PAY_CLOCK_SKEW_MS
}
