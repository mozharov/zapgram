import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
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
import type {PendingDonationService} from './pending.service.js'

export type DonationPayRail = 'internal' | 'nwc'

export type PayDonationResult =
  | {status: 'paid'; paymentHash?: string; rail: DonationPayRail | 'recovered'; amountSats?: number}
  | {status: 'pending'; paymentHash: string; expiresAt: Date; amountSats?: number; error: unknown}
  | {status: 'failed'; error: unknown; reason: 'invalid_amount' | 'no_funds' | 'pay_failed'}

type PayInvoiceResult = {payment_hash?: string | null}

export type DonationPayDeps = {
  createFeeCollectionInvoice: (
    sats: number,
  ) => Promise<{payment_hash: string; bolt11: string; expiry?: Date | null}>
  pending: Pick<PendingDonationService, 'save' | 'reconcileUser'>
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
      const unspent = error instanceof NWCPaymentFailedError || payLeftBackendUnspent(error)
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
        const payment = await wallet.payInvoice(invoice.bolt11)
        return {
          status: 'paid',
          paymentHash: payment.payment_hash ?? invoice.payment_hash,
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

  async function doPayDonation(input: {
    userId: number
    amountSats: number
    kind: 'one_shot' | 'monthly'
    pendingKind?: 'one_shot' | 'feature_request'
    rail?: DonationPayRail | 'auto'
    nwcUrl?: string | null
    nwc?: NostrWallet
    /** Extra product context (source UI, job, etc.). */
    analytics?: Record<string, unknown>
  }): Promise<PayDonationResult> {
    const pendingKind = input.pendingKind ?? 'one_shot'
    if (input.kind === 'one_shot') {
      const previous = await deps.pending.reconcileUser(input.userId, pendingKind)
      const unresolved = previous.find(item => item.state === 'pending')
      if (unresolved)
        return {
          status: 'pending',
          paymentHash: unresolved.row.paymentHash,
          expiresAt: unresolved.row.expiresAt,
          amountSats: unresolved.row.amountSats,
          error: new Error('Awaiting donation confirmation'),
        }
      const paid = previous.find(item => item.state === 'paid')
      if (paid)
        return {
          status: 'paid',
          paymentHash: paid.row.paymentHash,
          rail: 'recovered',
          amountSats: paid.row.amountSats,
        }
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

    const result = await payToFeeCollection({
      userId: input.userId,
      amountSats: input.amountSats,
      rail: requestedRail,
      nwcUrl: input.nwcUrl,
      nwc: input.nwc,
    })

    if (result.status === 'paid') {
      let ledgerOk = true
      try {
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
      if (input.kind === 'one_shot')
        await deps.pending.save({
          userId: input.userId,
          kind: pendingKind,
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

  // Serialize explicit retries so two callbacks cannot both pass the pending check before pay.
  const inFlight = new Map<string, Promise<PayDonationResult>>()
  async function payDonation(
    input: Parameters<typeof doPayDonation>[0],
  ): Promise<PayDonationResult> {
    const key = `${input.userId}:${input.kind}:${input.pendingKind ?? 'one_shot'}`
    const previous = inFlight.get(key)
    const current = (async () => {
      if (previous) await previous.catch(() => undefined)
      return doPayDonation(input)
    })()
    inFlight.set(key, current)
    try {
      return await current
    } finally {
      if (inFlight.get(key) === current) inFlight.delete(key)
    }
  }

  return {payToFeeCollection, payDonation}
}

export type DonationPayService = ReturnType<typeof createDonationPayService>
