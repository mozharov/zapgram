import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import type {DonationLedgerKind} from '@core/money/donation.js'
import {isValidDonationAmountSats} from '@core/money/donation.js'
import {donationInvoiceExpiresAt} from '@core/money/donation-payment.js'
import {satsToMsats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {payLeftBackendUnspent} from '@infra/lnbits/outgoing-liquidity.js'
import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'
import type {CaptureClient} from '@infra/posthog.js'
import {captureUserEvent, captureUserException, errorProperties} from '@infra/posthog.js'
import type {UserRepository} from '../users/repository.js'
import type {PendingDonationService} from './pending.service.js'
import type {DonationRepository} from './repository.js'

export type DonationPayRail = 'internal' | 'nwc'

export type PayDonationResult =
  | {status: 'paid'; paymentHash: string; rail: DonationPayRail | 'recovered'; amountSats?: number}
  | {
      status: 'pending'
      paymentHash: string
      expiresAt: Date
      amountSats?: number
      existing?: boolean
      error: unknown
    }
  | {status: 'failed'; error: unknown; reason: 'invalid_amount' | 'no_funds' | 'pay_failed'}

export type MonthlyDonationResult =
  | PayDonationResult
  | {status: 'skipped'; reason: 'issuance_busy' | 'already_paid' | 'period_changed'}

type PayInvoiceResult = {payment_hash?: string | null}

export type DonationPayDeps = {
  createFeeCollectionInvoice: (
    sats: number,
  ) => Promise<{payment_hash: string; bolt11: string; expiry?: Date | null}>
  pending: Pick<PendingDonationService, 'save' | 'reconcileUser' | 'complete' | 'remove'>
  issuance: Pick<
    DonationRepository,
    | 'reserveIssuance'
    | 'releaseIssuance'
    | 'saveIssued'
    | 'saveMonthlyIssued'
    | 'clearMonthlyIssued'
  >
  users: Pick<UserRepository, 'getOrThrow'>
  getUserWallet: (userId: User['id']) => Promise<{
    balance: number
    payInvoice: (bolt11: string) => Promise<PayInvoiceResult>
  }>
  insertDonation: (input: {
    userId: number
    amountSats: number
    kind: DonationLedgerKind
    paymentHash?: string | null
  }) => Promise<unknown>
  log: AppLogger
  posthog?: CaptureClient
  /** Build NWC client from stored URL when needed. */
  createNwc?: (nwcUrl: string) => NostrWallet
}

/**
 * Pay a fee-collection invoice for an explicit donation (one-shot / monthly) or auto-% collect.
 *
 * Rail modes:
 * - `internal` / `nwc`: force that rail
 * - `auto`: internal if balance covers amount, else NWC if available
 */
export function createDonationPayService(deps: DonationPayDeps) {
  async function payToFeeCollection(input: {
    userId: number
    amountSats: number
    rail: DonationPayRail | 'auto'
    nwcUrl?: string | null
    nwc?: NostrWallet
    beforePay?: (invoice: {paymentHash: string; expiresAt: Date}) => Promise<boolean>
  }): Promise<PayDonationResult> {
    const {userId, amountSats} = input
    if (!isValidDonationAmountSats(amountSats)) {
      return {status: 'failed', error: new Error('invalid amount'), reason: 'invalid_amount'}
    }

    let invoice: {payment_hash: string; bolt11: string; expiry?: Date | null}
    try {
      invoice = await deps.createFeeCollectionInvoice(amountSats)
    } catch (error) {
      deps.log.error({error, userId, amountSats}, 'Failed to create fee-collection invoice')
      captureUserException(deps.posthog, error, userId, {
        feature: 'donations',
        stage: 'create_fee_collection_invoice',
        amount_sats: amountSats,
        requested_rail: input.rail,
      })
      return {status: 'failed', error, reason: 'pay_failed'}
    }

    const expiresAt = donationInvoiceExpiresAt(invoice.expiry)
    if (
      input.beforePay &&
      !(await input.beforePay({paymentHash: invoice.payment_hash, expiresAt}))
    ) {
      return {status: 'failed', error: new Error('Donation issuance changed'), reason: 'pay_failed'}
    }
    const failedPay = (
      error: unknown,
      stage: 'pay_internal' | 'pay_nwc',
      logMessage: string,
      payStarted: boolean,
    ): PayDonationResult => {
      // The liquidity guard already logged and captured the pause. Don't file it as a pay exception.
      if (error instanceof SendPausedError) {
        return {status: 'failed', error, reason: 'pay_failed'}
      }
      deps.log.error({error, userId, amountSats}, logMessage)
      // Short balance is expected. Keep the pay_failed reason; do not open an exception.
      if (!(error instanceof InsufficientFundsError)) {
        captureUserException(deps.posthog, error, userId, {
          feature: 'donations',
          stage,
          amount_sats: amountSats,
          requested_rail: input.rail,
          invoice_payment_hash: invoice.payment_hash,
        })
      }
      // NWC 'Could not pay' may follow a debit; it cannot release this invoice hash.
      const unspent = payLeftBackendUnspent(error)
      if (payStarted && (error instanceof InvoiceAlreadyPaidError || !unspent)) {
        return {status: 'pending', paymentHash: invoice.payment_hash, expiresAt, error}
      }
      return {status: 'failed', error, reason: 'pay_failed'}
    }

    let internalPayStarted = false
    const tryInternal = async (): Promise<PayDonationResult | null> => {
      try {
        const wallet = await deps.getUserWallet(userId)
        if (wallet.balance < satsToMsats(amountSats)) return null
        internalPayStarted = true
        await wallet.payInvoice(invoice.bolt11)
        return {
          status: 'paid',
          paymentHash: invoice.payment_hash,
          rail: 'internal',
        }
      } catch (error) {
        return failedPay(error, 'pay_internal', 'Internal donation pay failed', internalPayStarted)
      }
    }

    const tryNwc = async (): Promise<PayDonationResult | null> => {
      const nwc =
        input.nwc ?? (input.nwcUrl && deps.createNwc ? deps.createNwc(input.nwcUrl) : undefined)
      if (!nwc) return null
      try {
        await nwc.payInvoice(invoice.bolt11)
        return {
          status: 'paid',
          paymentHash: invoice.payment_hash,
          rail: 'nwc',
        }
      } catch (error) {
        return failedPay(error, 'pay_nwc', 'NWC donation pay failed', true)
      }
    }

    if (input.rail === 'internal') {
      try {
        const wallet = await deps.getUserWallet(userId)
        if (wallet.balance < satsToMsats(amountSats)) {
          return {status: 'failed', error: new Error('insufficient funds'), reason: 'no_funds'}
        }
      } catch (error) {
        deps.log.error({error, userId}, 'Donation getUserWallet failed')
        captureUserException(deps.posthog, error, userId, {
          feature: 'donations',
          stage: 'get_user_wallet',
          amount_sats: amountSats,
          requested_rail: input.rail,
        })
        return {status: 'failed', error, reason: 'pay_failed'}
      }
      const result = await tryInternal()
      return (
        result ?? {status: 'failed', error: new Error('internal pay failed'), reason: 'pay_failed'}
      )
    }

    if (input.rail === 'nwc') {
      const result = await tryNwc()
      return result ?? {status: 'failed', error: new Error('nwc unavailable'), reason: 'no_funds'}
    }

    // auto: internal first, then NWC
    const internal = await tryInternal()
    // A timeout or uncertain provider response may already have debited this rail.
    if (internal?.status === 'paid' || internal?.status === 'pending') return internal
    const nwcResult = await tryNwc()
    if (nwcResult) return nwcResult
    if (internal?.status === 'failed') return internal
    return {status: 'failed', error: new Error('no funds'), reason: 'no_funds'}
  }

  async function doPayDonation(
    input: {
      userId: number
      amountSats: number
      kind: 'one_shot' | 'monthly'
      pendingKind?: 'one_shot' | 'feature_request'
      attemptId?: string
      now?: Date
      rail?: DonationPayRail | 'auto'
      nwcUrl?: string | null
      nwc?: NostrWallet
      /** Extra product context (source UI, job, etc.). */
      analytics?: Record<string, unknown>
    },
    slot?: NonNullable<Awaited<ReturnType<DonationRepository['reserveIssuance']>>>,
  ): Promise<MonthlyDonationResult> {
    const pendingKind = input.pendingKind ?? 'one_shot'
    const reconcile = async (observed = slot?.rows) => {
      const previous = await deps.pending.reconcileUser(
        input.userId,
        pendingKind,
        input.attemptId,
        observed,
      )
      const unresolved = previous.find(item => item.state === 'pending')
      if (unresolved)
        return {
          status: 'pending' as const,
          paymentHash: unresolved.row.paymentHash,
          expiresAt: unresolved.row.expiresAt,
          amountSats: unresolved.row.amountSats,
          error: new Error('Awaiting donation confirmation'),
        }
      const paid = previous.find(item => item.state === 'paid')
      if (paid)
        return {
          status: 'paid' as const,
          paymentHash: paid.row.paymentHash,
          rail: 'recovered' as const,
          amountSats: paid.row.amountSats,
        }
      return undefined
    }
    if (input.kind === 'one_shot') {
      const previous = await reconcile()
      if (previous) return previous
    }
    const requestedRail = input.rail ?? 'auto'
    const hasNwc = Boolean(input.nwc || input.nwcUrl)
    const baseProps = {
      feature: 'donations',
      amount_sats: input.amountSats,
      kind: input.kind,
      requested_rail: requestedRail,
      has_nwc: hasNwc,
      ...input.analytics,
    }

    // Re-read immediately before mint while holding the cross-process issuance lease.
    if (input.kind === 'one_shot') {
      const previous = await reconcile([])
      if (previous) return previous
    }
    if (input.kind === 'monthly') {
      const user = await deps.users.getOrThrow(input.userId)
      if (user.monthlyDonationLastHash)
        return {
          status: 'pending',
          paymentHash: user.monthlyDonationLastHash,
          expiresAt: user.monthlyDonationExpiresAt ?? donationInvoiceExpiresAt(null),
          amountSats: user.monthlyDonationSats,
          existing: true,
          error: new Error('Awaiting monthly donation confirmation'),
        }
      if (user.monthlyDonationNextAt && user.monthlyDonationNextAt > (input.now ?? new Date()))
        return {status: 'skipped', reason: 'already_paid'}
    }
    let issuedHash: string | undefined
    let periodChanged = false
    const result = await payToFeeCollection({
      userId: input.userId,
      amountSats: input.amountSats,
      rail: requestedRail,
      nwcUrl: input.nwcUrl,
      nwc: input.nwc,
      beforePay: slot
        ? async invoice => {
            if (input.kind === 'monthly') {
              const saved = await deps.issuance.saveMonthlyIssued(
                slot,
                input.userId,
                {...invoice, amountSats: input.amountSats},
                input.now,
              )
              if (saved) {
                issuedHash = invoice.paymentHash
                deps.log.info(
                  {userId: input.userId, paymentHash: issuedHash},
                  'Monthly donation invoice saved before payment',
                )
              } else periodChanged = true
              return saved
            }
            const saved = await deps.issuance.saveIssued(slot, {
              userId: input.userId,
              kind: pendingKind,
              attemptId: input.attemptId ?? null,
              amountSats: input.amountSats,
              paymentHash: invoice.paymentHash,
              expiresAt: invoice.expiresAt,
            })
            if (saved) issuedHash = invoice.paymentHash
            return saved
          }
        : undefined,
    })

    if (periodChanged) return {status: 'skipped', reason: 'period_changed'}

    if (result.status === 'paid') {
      let ledgerOk = true
      try {
        if (issuedHash && input.kind === 'one_shot') await deps.pending.complete(issuedHash)
        else
          await deps.insertDonation({
            userId: input.userId,
            amountSats: input.amountSats,
            kind: input.kind,
            paymentHash: result.paymentHash,
          })
      } catch (error) {
        ledgerOk = false
        deps.log.error({error, userId: input.userId}, 'Failed to insert donation ledger row')
        captureUserException(deps.posthog, error, input.userId, {
          ...baseProps,
          stage: 'ledger_insert',
          rail: result.rail,
          payment_hash: result.paymentHash ?? null,
        })
        captureUserEvent(deps.posthog, 'donation_ledger_failed', input.userId, {
          ...baseProps,
          rail: result.rail,
          payment_hash: result.paymentHash ?? null,
          ...errorProperties(error),
        })
      }
      captureUserEvent(deps.posthog, 'donate_sent', input.userId, {
        ...baseProps,
        status: 'paid',
        rail: result.rail,
        payment_hash: result.paymentHash ?? null,
        ledger_written: ledgerOk,
      })
    } else if (result.status === 'pending') {
      if (input.kind === 'one_shot' && !issuedHash)
        await deps.pending.save({
          userId: input.userId,
          kind: pendingKind,
          attemptId: input.attemptId ?? null,
          amountSats: input.amountSats,
          paymentHash: result.paymentHash,
          expiresAt: result.expiresAt,
        })
      deps.log.info(
        {userId: input.userId, paymentHash: result.paymentHash},
        'Donation payment awaiting confirmation',
      )
      captureUserEvent(deps.posthog, 'donation_pending', input.userId, {
        ...baseProps,
        status: 'pending',
        payment_hash: result.paymentHash,
      })
    } else {
      if (issuedHash) {
        if (input.kind === 'monthly') {
          await deps.issuance.clearMonthlyIssued(input.userId, issuedHash)
          deps.log.info(
            {userId: input.userId, paymentHash: issuedHash},
            'Unspent monthly donation invoice cleared',
          )
        } else await deps.pending.remove(issuedHash)
      }
      captureUserEvent(deps.posthog, 'donation_failed', input.userId, {
        ...baseProps,
        status: 'failed',
        reason: result.reason,
        ...errorProperties(result.error),
      })
      if (
        result.reason === 'pay_failed' &&
        result.error &&
        !(result.error instanceof InsufficientFundsError) &&
        !(result.error instanceof SendPausedError)
      ) {
        captureUserException(deps.posthog, result.error, input.userId, {
          ...baseProps,
          stage: 'pay_donation',
          reason: result.reason,
        })
      }
    }

    return result
  }

  async function withIssuanceSlot(input: Parameters<typeof doPayDonation>[0]) {
    const slot = await deps.issuance.reserveIssuance(
      input.userId,
      input.kind === 'monthly' ? 'monthly' : (input.pendingKind ?? 'one_shot'),
      input.attemptId,
    )
    if (!slot) {
      if (input.kind === 'monthly')
        return {status: 'skipped' as const, reason: 'issuance_busy' as const}
      return {
        status: 'failed' as const,
        reason: 'pay_failed' as const,
        error: new Error('Donation issuance in progress'),
      }
    }
    try {
      return await doPayDonation(input, slot)
    } finally {
      await deps.issuance.releaseIssuance(slot)
    }
  }

  const inFlight = new Map<string, Promise<MonthlyDonationResult>>()
  type DonationInput = Parameters<typeof doPayDonation>[0]
  function payDonation(input: DonationInput & {kind: 'monthly'}): Promise<MonthlyDonationResult>
  function payDonation(input: DonationInput & {kind: 'one_shot'}): Promise<PayDonationResult>
  function payDonation(input: DonationInput): Promise<MonthlyDonationResult> {
    // Monthly callers finalize schedules independently. Only the lease owner may receive `paid`.
    if (input.kind === 'monthly') return withIssuanceSlot(input)
    const key = `${input.userId}:${input.kind}:${input.pendingKind ?? 'one_shot'}${input.pendingKind === 'feature_request' ? `:${input.attemptId ?? ''}` : ''}`
    const previous = inFlight.get(key)
    if (previous) return previous
    const current = withIssuanceSlot(input).finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key)
    })
    inFlight.set(key, current)
    return current
  }

  return {payToFeeCollection, payDonation}
}

export type DonationPayService = ReturnType<typeof createDonationPayService>
