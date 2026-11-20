import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {computeDonationSats, type DonationScope, shouldApplyDonation} from '@core/money/donation.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {DmTransfer} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import {type CaptureClient, captureUserEvent, captureUserException} from '@infra/posthog.js'
import type {DmTransferRepository} from './dm-transfer.repository.js'

/** How long a recipient-notice claim is held. A crash after that can send once more. */
export const NOTICE_LEASE_MS = 60_000
/** An invoice that was saved and never submitted is abandoned after this. */
export const INVOICE_GRACE_MS = 2 * 60_000
/** An unknown pay is not retried. After this it is logged once for a person. */
export const PAY_REVIEW_MS = 24 * 60 * 60_000
/** Failed recipient notices stop after this many tries. A 403 stops on the first. */
export const NOTICE_ATTEMPT_LIMIT = 8

export type DmTransferSettlement =
  | {outcome: 'settled'; fee: 'collected' | 'skipped' | 'failed'; notice: 'sent' | 'failed'}
  | {outcome: 'in_flight'}
  | {outcome: 'blocked'}
  | {outcome: 'rejected'; reason: 'insufficient_funds'}

export type DmTransferRail = 'internal' | 'nwc'

type Invoice = {payment_hash: string; bolt11: string}
type PayResult = {paymentHash?: string} | undefined

export type DmTransferDeps = {
  transfers: DmTransferRepository
  log: AppLogger
  posthog?: CaptureClient
  now?: () => Date
  noticeLeaseMs?: number
  invoiceGraceMs?: number
  payReviewMs?: number
  createRecipientInvoice: (toUserId: number, sats: number) => Promise<Invoice>
  lookupRecipient: (toUserId: number, hash: string) => Promise<PayoutState>
  createFeeInvoice: (sats: number) => Promise<Invoice>
  lookupFee: (hash: string) => Promise<PayoutState>
  /**
   * Pays a bolt11 from the sender. The recipient invoice was just created on this
   * LNbits, so that pay passes `knownInternal` and skips the funding-source guard.
   * The fee invoice does not: it is classified like any other outgoing pay.
   */
  pay: (
    userId: number,
    bolt11: string,
    rail: DmTransferRail,
    options?: {knownInternal?: boolean},
  ) => Promise<PayResult>
  getUser: (userId: number) => Promise<{
    donationPercent: number
    donationScope: DonationScope
    username?: string | null
  }>
  findDonation: (paymentHash: string) => Promise<unknown>
  insertDonation: (input: {
    userId: number
    amountSats: number
    paymentHash: string
  }) => Promise<unknown>
  notify: (input: {
    toUserId: number
    fromUserId: number
    sats: number
  }) => Promise<boolean | 'unreachable'>
  notifySender?: (input: {
    fromUserId: number
    toUserId: number
    sats: number
    outcome: 'settled' | 'abandoned' | 'needs_review'
  }) => Promise<boolean>
}

type Primary = {status: 'paid' | 'in_flight' | 'rejected' | 'blocked'; settledNow: boolean}

/**
 * One confirmation, one debit.
 *
 * The row is reserved before any invoice is paid. The recipient invoice is stored
 * before pay, and the phase flips to `pay_unknown` before the wallet call, so a
 * crash during that call is not treated as "pay was never attempted".
 *
 * A provider acceptance settles the primary even if the following lookup or
 * `markSettled` fails. Those rows are finished by `reconcile`, not by a new nonce.
 * An unknown pay result is `in_flight`: no second invoice, no generic error.
 */
export function createDmTransferService(deps: DmTransferDeps) {
  const now = () => deps.now?.() ?? new Date()
  const leaseMs = deps.noticeLeaseMs ?? NOTICE_LEASE_MS
  const graceMs = deps.invoiceGraceMs ?? INVOICE_GRACE_MS
  const reviewMs = deps.payReviewMs ?? PAY_REVIEW_MS

  async function settle(input: {
    attemptId: string
    fromUserId: number
    toUserId: number
    sats: number
    rail: DmTransferRail
  }): Promise<DmTransferSettlement> {
    const open = await deps.transfers.findOpen(input.fromUserId, input.toUserId)
    if (open && open.id !== input.attemptId) return {outcome: 'blocked'}

    const row = await deps.transfers.reserve({
      id: input.attemptId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      sats: input.sats,
      rail: input.rail,
      createdAt: now(),
    })
    if (
      row.fromUserId !== input.fromUserId ||
      row.toUserId !== input.toUserId ||
      row.sats !== input.sats
    ) {
      throw new Error('DM transfer attempt does not match the reserved send')
    }

    if (row.phase === 'abandoned') return {outcome: 'rejected', reason: 'insufficient_funds'}
    // A replay of a row that is already settled may finish the fee. A worker that
    // lost `markSettled` must not start a second donation.
    const alreadySettled = row.status === 'settled'
    if (alreadySettled) await deps.transfers.claimSenderNotice(row.id)
    let wonSettle = alreadySettled
    if (!alreadySettled && row.phase !== 'provider_accepted') {
      const primary = await settlePrimary(row, input)
      if (primary.status === 'in_flight') {
        deps.log.info(
          {fromUserId: input.fromUserId, toUserId: input.toUserId, sats: input.sats},
          'DM transfer outcome unknown',
        )
        return {outcome: 'in_flight'}
      }
      if (primary.status === 'blocked') return {outcome: 'blocked'}
      if (primary.status === 'rejected') return {outcome: 'rejected', reason: 'insufficient_funds'}
      wonSettle = primary.settledNow
    } else if (row.phase === 'provider_accepted') {
      wonSettle = await settleMark(row.id)
    }
    if (!wonSettle) {
      const latest = await deps.transfers.get(input.attemptId)
      if (latest.status !== 'settled') return {outcome: 'in_flight'}
    }

    const fee = await settleFee(input, !wonSettle).catch(error => {
      deps.log.error({error, fromUserId: input.fromUserId}, 'DM transfer fee failed')
      return 'failed' as const
    })

    const notice = await settleNotice(input).catch(error => {
      deps.log.error({error, toUserId: input.toUserId}, 'DM transfer notice failed')
      return 'failed' as const
    })
    deps.log.info(
      {fromUserId: input.fromUserId, toUserId: input.toUserId, sats: input.sats, fee, notice},
      'DM transfer settled',
    )
    return {outcome: 'settled', fee, notice}
  }

  async function settlePrimary(
    row: DmTransfer,
    input: {toUserId: number; sats: number; fromUserId: number},
  ): Promise<Primary> {
    const current = await ensureInvoice(row, input)
    if (current === 'in_flight' || current === 'rejected') {
      return {status: current, settledNow: false}
    }
    return payKnownInvoice(current, input.fromUserId)
  }

  async function ensureInvoice(
    row: DmTransfer,
    input: {toUserId: number; sats: number},
  ): Promise<DmTransfer | 'in_flight' | 'rejected'> {
    if (row.phase === 'abandoned') return 'rejected'
    if (row.invoiceHash && row.bolt11 && row.phase !== 'reserved') return row
    const invoice = await deps.createRecipientInvoice(input.toUserId, input.sats)
    const saved = await deps.transfers.saveInvoice(row.id, row.invoiceHash, {
      hash: invoice.payment_hash,
      bolt11: invoice.bolt11,
    })
    if (!saved?.bolt11 || !saved.invoiceHash) return 'in_flight'
    return saved
  }

  async function payKnownInvoice(row: DmTransfer, fromUserId: number): Promise<Primary> {
    if (row.phase === 'provider_accepted' || row.providerAccepted) {
      return {status: 'paid', settledNow: await settleMark(row.id)}
    }
    if (row.phase === 'pay_unknown' || row.phase === 'needs_review') {
      return observePay(row)
    }
    if (row.phase !== 'invoice_saved') return {status: 'in_flight', settledNow: false}
    try {
      const claimed = await deps.transfers.markPhase(row.id, 'pay_unknown', 'invoice_saved')
      if (!claimed) return {status: 'in_flight', settledNow: false}
      return submitPay(claimed, fromUserId)
    } catch (error) {
      if (!isConstraint(error)) throw error
      // Losing the open-send index means pay was never called for this invoice.
      // The wizard reports the blocked send, so recovery has nothing left to tell.
      await deps.transfers.abandonIfPhase(row.id, 'invoice_saved', true)
      return {status: 'blocked', settledNow: false}
    }
  }

  async function submitPay(row: DmTransfer, fromUserId: number): Promise<Primary> {
    if (!row.bolt11) return {status: 'in_flight', settledNow: false}
    try {
      const paid = await deps.pay(fromUserId, row.bolt11, row.rail, {knownInternal: true})
      // The sender controls NWC. Only our recipient LNbits can confirm receipt.
      if (row.rail === 'nwc') return observePay(row)
      await deps.transfers.markProviderAccepted(row.id, paid?.paymentHash)
      if (row.invoiceHash) await lookupQuiet(row.toUserId, row.invoiceHash)
      return {status: 'paid', settledNow: await settleMark(row.id)}
    } catch (error) {
      if (error instanceof InvoiceAlreadyPaidError) {
        if (row.rail === 'nwc') return observePay(row)
        await deps.transfers.markProviderAccepted(row.id, undefined)
        return {status: 'paid', settledNow: await settleMark(row.id)}
      }
      if (error instanceof InsufficientFundsError) {
        await deps.transfers.abandonIfPhase(row.id, 'pay_unknown', true)
        return {status: 'rejected', settledNow: false}
      }
      // Timeout, transport, or an unclassified provider error. The debit may
      // have landed. Do not throw and do not mint another invoice.
      deps.log.info(
        {transferId: row.id, name: error instanceof Error ? error.name : 'unknown'},
        'DM transfer pay outcome unknown',
      )
      return {status: 'in_flight', settledNow: false}
    }
  }

  async function observePay(row: DmTransfer): Promise<Primary> {
    if (!row.invoiceHash) return {status: 'in_flight', settledNow: false}
    const state = await lookupQuiet(row.toUserId, row.invoiceHash)
    if (state === 'paid') {
      await deps.transfers.markProviderAccepted(row.id, row.providerPaymentHash ?? undefined)
      return {status: 'paid', settledNow: await settleMark(row.id)}
    }
    // `retryable` is also a 404, which is not proof the pay never left.
    return {status: 'in_flight', settledNow: false}
  }

  async function settleMark(id: string, senderNotified = true): Promise<boolean> {
    try {
      return await deps.transfers.markSettled(id, senderNotified)
    } catch (error) {
      deps.log.error({error, transferId: id}, 'DM transfer settle mark failed')
      return false
    }
  }

  function isConstraint(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return code.includes('CONSTRAINT')
  }

  async function lookupQuiet(toUserId: number, hash: string): Promise<PayoutState | 'unknown'> {
    try {
      return await deps.lookupRecipient(toUserId, hash)
    } catch (error) {
      deps.log.info(
        {name: error instanceof Error ? error.name : 'unknown'},
        'DM transfer lookup failed',
      )
      return 'unknown'
    }
  }

  async function settleFee(
    input: {
      attemptId: string
      fromUserId: number
    },
    observeOnly = false,
  ): Promise<'collected' | 'skipped' | 'failed'> {
    const row = await deps.transfers.get(input.attemptId)
    if (row.status !== 'settled') return 'skipped'
    if (row.feeSkipped) return 'skipped'
    const user = await deps.getUser(input.fromUserId)
    if (!shouldApplyDonation(user.donationScope, 'tip')) return 'skipped'
    const amountSats = computeDonationSats(row.sats, user.donationPercent)
    if (amountSats <= 0) return 'skipped'

    if (row.feeHash) {
      const state = await lookupFeeQuiet(row.feeHash)
      if (state === 'paid') {
        await recordFee(input.fromUserId, row.feeHash, amountSats)
        return 'collected'
      }
      return 'failed'
    }

    if (observeOnly) return 'skipped'
    const invoice = await deps.createFeeInvoice(amountSats)
    const saved = await deps.transfers.saveFeeInvoice(input.attemptId, {
      hash: invoice.payment_hash,
      bolt11: invoice.bolt11,
    })
    if (!saved) return settleFee(input, true)
    const bolt11 = saved.feeBolt11
    const hash = saved.feeHash
    if (!bolt11 || !hash) return 'failed'
    try {
      await deps.pay(input.fromUserId, bolt11, row.rail)
    } catch (error) {
      if (error instanceof InvoiceAlreadyPaidError) {
        await recordFee(input.fromUserId, hash, amountSats)
        return 'collected'
      }
      if (error instanceof InsufficientFundsError) {
        await deps.transfers.markFeeSkipped(input.attemptId)
        captureUserEvent(deps.posthog, 'donation_failed', input.fromUserId, {
          feature: 'donations',
          flow: 'percent',
          status: 'failed',
          reason: 'no_funds',
          amount_sats: amountSats,
          payment_kind: 'tip',
        })
        return 'skipped'
      }
      captureUserException(deps.posthog, error, input.fromUserId, {
        feature: 'donations',
        stage: 'dm_transfer_fee',
        amount_sats: amountSats,
      })
      return 'failed'
    }
    await recordFee(input.fromUserId, hash, amountSats)
    return 'collected'
  }

  async function lookupFeeQuiet(hash: string): Promise<PayoutState | 'unknown'> {
    try {
      return await deps.lookupFee(hash)
    } catch {
      return 'unknown'
    }
  }

  async function recordFee(userId: number, paymentHash: string, amountSats: number) {
    if (amountSats <= 0) return
    if (await deps.findDonation(paymentHash)) return
    await deps.insertDonation({userId, amountSats, paymentHash})
    captureUserEvent(deps.posthog, 'donation_collected', userId, {
      feature: 'donations',
      flow: 'percent',
      status: 'paid',
      amount_sats: amountSats,
      payment_kind: 'tip',
      payment_hash: paymentHash,
    })
  }

  async function settleNotice(input: {
    attemptId: string
    toUserId: number
    fromUserId: number
    sats: number
  }): Promise<'sent' | 'failed'> {
    const row = await deps.transfers.get(input.attemptId)
    if (row.noticeSent) return 'sent'
    if (row.noticeDropped) return 'failed'
    if (row.status !== 'settled') return 'failed'
    const claimed = await deps.transfers.claimNotice(input.attemptId, now(), leaseMs)
    if (!claimed) return 'failed'
    try {
      const sent = await deps.notify({
        toUserId: input.toUserId,
        fromUserId: input.fromUserId,
        sats: input.sats,
      })
      if (sent !== true) {
        const current = await deps.transfers.get(input.attemptId)
        const drop = sent === 'unreachable' || current.noticeAttempts + 1 >= NOTICE_ATTEMPT_LIMIT
        await deps.transfers.recordNoticeFailure(input.attemptId, drop)
        return 'failed'
      }
      await deps.transfers.markNoticeSent(input.attemptId)
      return 'sent'
    } catch (error) {
      await deps.transfers.releaseNotice(input.attemptId)
      throw error
    }
  }

  /**
   * Finish a row without paying it again.
   * `invoice_saved` past the grace period never called pay, so it is abandoned.
   * `pay_unknown` is looked up. Paid becomes settled. A definitive miss past the
   * review window is abandoned. Anything still ambiguous is logged once.
   */
  async function reconcile(
    id: string,
  ): Promise<'settled' | 'abandoned' | 'in_flight' | 'needs_review'> {
    const row = await deps.transfers.get(id)
    if (row.phase === 'abandoned') {
      await tellSender(row, 'abandoned')
      return 'abandoned'
    }
    if (row.providerAccepted || row.phase === 'provider_accepted') {
      await settleMark(row.id, false)
      const latest = await deps.transfers.get(id)
      if (latest.status !== 'settled') return 'in_flight'
      return finishSettled(latest)
    }
    if (row.status === 'settled') return finishSettled(row)
    if (row.phase === 'reserved' || row.phase === 'invoice_saved') {
      if (ageMs(row) > graceMs) return abandon(row, row.phase)
      return 'in_flight'
    }
    if (!row.invoiceHash) return 'in_flight'
    const state = await lookupQuiet(row.toUserId, row.invoiceHash)
    if (state === 'paid') {
      await deps.transfers.markProviderAccepted(row.id, row.providerPaymentHash ?? undefined)
      await settleMark(row.id, false)
      const latest = await deps.transfers.get(id)
      if (latest.status !== 'settled') return 'in_flight'
      return finishSettled(latest)
    }
    if (state === 'retryable' && ageMs(row) > reviewMs) {
      const left = await abandon(row, row.phase === 'needs_review' ? 'needs_review' : 'pay_unknown')
      if (left === 'abandoned') {
        deps.log.error(
          {transferId: row.id},
          'DM transfer abandoned after the provider reported no payment',
        )
      }
      return left
    }
    if (row.phase === 'needs_review') {
      await tellSender(row, 'needs_review')
      await deps.transfers.deferReview(row.id, new Date(now().getTime() + 60 * 60_000))
      return 'in_flight'
    }
    if ((state === 'pending' || state === 'unknown') && ageMs(row) > reviewMs) {
      const logged = await deps.transfers.markNeedsReview(row.id)
      if (logged) {
        deps.log.error(
          {transferId: row.id},
          'DM transfer needs a person: the pay outcome is still unknown',
        )
        await tellSender(row, 'needs_review')
        await deps.transfers.deferReview(row.id, new Date(now().getTime() + 60 * 60_000))
      }
      return 'needs_review'
    }
    return 'in_flight'
  }

  /**
   * Fee, then the recipient notice. `in_flight` means the notice is still due, so
   * recovery does not treat the row as gone and can read the rows after it.
   */
  async function abandon(
    row: DmTransfer,
    expected: 'reserved' | 'invoice_saved' | 'pay_unknown' | 'needs_review',
  ): Promise<'abandoned' | 'in_flight'> {
    const left = await deps.transfers.abandonIfPhase(row.id, expected)
    if (!left) return 'in_flight'
    await tellSender({...row, phase: 'abandoned'}, 'abandoned')
    return 'abandoned'
  }

  async function tellSender(row: DmTransfer, outcome: 'settled' | 'abandoned' | 'needs_review') {
    const review = outcome === 'needs_review'
    if (!deps.notifySender || (review ? row.reviewNotified : row.senderNotified)) return
    const claimed = await deps.transfers.claimSenderNotice(row.id, review)
    if (!claimed) return
    try {
      const sent = await deps.notifySender({
        fromUserId: row.fromUserId,
        toUserId: row.toUserId,
        sats: row.sats,
        outcome,
      })
      if (!sent) await deps.transfers.releaseSenderNotice(row.id, review)
    } catch (error) {
      await deps.transfers.releaseSenderNotice(row.id, review)
      deps.log.error({error, transferId: row.id}, 'DM transfer sender notice failed')
    }
  }

  async function finishSettled(row: DmTransfer): Promise<'settled' | 'in_flight'> {
    await tellSender(row, 'settled')
    await settleFee({attemptId: row.id, fromUserId: row.fromUserId}).catch(error => {
      deps.log.error({error, fromUserId: row.fromUserId}, 'DM transfer fee failed')
    })
    try {
      const notice = await settleNotice({
        attemptId: row.id,
        toUserId: row.toUserId,
        fromUserId: row.fromUserId,
        sats: row.sats,
      })
      return notice === 'sent' ? 'settled' : 'in_flight'
    } catch (error) {
      deps.log.error({error, transferId: row.id}, 'DM transfer notice failed')
      return 'in_flight'
    }
  }

  function ageMs(row: DmTransfer): number {
    return now().getTime() - row.createdAt.getTime()
  }

  async function listActionable(limit: number, offset: number) {
    return deps.transfers.listActionable(limit, offset, now())
  }

  return {
    settle,
    reconcile,
    listActionable,
    releaseSenderNotice: (id: string) => deps.transfers.releaseSenderNotice(id),
  }
}

export type DmTransferService = ReturnType<typeof createDmTransferService>
