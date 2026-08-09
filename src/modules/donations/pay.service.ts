import type {DonationLedgerKind} from '@core/money/donation.js'
import {isValidDonationAmountSats} from '@core/money/donation.js'
import {satsToMsats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'
import type {CaptureClient} from '@infra/posthog.js'
import {captureUserEvent} from '@infra/posthog.js'

export type DonationPayRail = 'internal' | 'nwc'

export type PayDonationResult =
  | {status: 'paid'; paymentHash?: string; rail: DonationPayRail}
  | {status: 'failed'; error: unknown; reason: 'invalid_amount' | 'no_funds' | 'pay_failed'}

type PayInvoiceResult = {payment_hash?: string | null}

export type DonationPayDeps = {
  createFeeCollectionInvoice: (sats: number) => Promise<{payment_hash: string; bolt11: string}>
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

    let invoice: {payment_hash: string; bolt11: string}
    try {
      invoice = await deps.createFeeCollectionInvoice(amountSats)
    } catch (error) {
      deps.log.error({error, userId, amountSats}, 'Failed to create fee-collection invoice')
      return {status: 'failed', error, reason: 'pay_failed'}
    }

    const tryInternal = async (): Promise<PayDonationResult | null> => {
      try {
        const wallet = await deps.getUserWallet(userId)
        if (wallet.balance < satsToMsats(amountSats)) return null
        const payment = await wallet.payInvoice(invoice.bolt11)
        return {
          status: 'paid',
          paymentHash: payment.payment_hash ?? invoice.payment_hash,
          rail: 'internal',
        }
      } catch (error) {
        deps.log.error({error, userId, amountSats}, 'Internal donation pay failed')
        return {status: 'failed', error, reason: 'pay_failed'}
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
        deps.log.error({error, userId, amountSats}, 'NWC donation pay failed')
        return {status: 'failed', error, reason: 'pay_failed'}
      }
    }

    if (input.rail === 'internal') {
      const wallet = await deps.getUserWallet(userId)
      if (wallet.balance < satsToMsats(amountSats)) {
        return {status: 'failed', error: new Error('insufficient funds'), reason: 'no_funds'}
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
    if (internal?.status === 'paid') return internal
    if (internal?.status === 'failed' && internal.reason === 'pay_failed') {
      // Balance was enough but pay failed — still try NWC if available
    }
    const nwcResult = await tryNwc()
    if (nwcResult) return nwcResult
    if (internal?.status === 'failed') return internal
    return {status: 'failed', error: new Error('no funds'), reason: 'no_funds'}
  }

  async function payDonation(input: {
    userId: number
    amountSats: number
    kind: 'one_shot' | 'monthly'
    rail?: DonationPayRail | 'auto'
    nwcUrl?: string | null
    nwc?: NostrWallet
  }): Promise<PayDonationResult> {
    const result = await payToFeeCollection({
      userId: input.userId,
      amountSats: input.amountSats,
      rail: input.rail ?? 'auto',
      nwcUrl: input.nwcUrl,
      nwc: input.nwc,
    })

    if (result.status === 'paid') {
      try {
        await deps.insertDonation({
          userId: input.userId,
          amountSats: input.amountSats,
          kind: input.kind,
          paymentHash: result.paymentHash,
        })
      } catch (error) {
        deps.log.error({error, userId: input.userId}, 'Failed to insert donation ledger row')
      }
      captureUserEvent(deps.posthog, 'donate_sent', input.userId, {
        amount_sats: input.amountSats,
        kind: input.kind,
        rail: result.rail,
      })
    } else {
      captureUserEvent(deps.posthog, 'donation_failed', input.userId, {
        amount_sats: input.amountSats,
        kind: input.kind,
        reason: result.reason,
      })
    }

    return result
  }

  return {payToFeeCollection, payDonation}
}

export type DonationPayService = ReturnType<typeof createDonationPayService>
