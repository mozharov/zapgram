import {SendPausedError} from '@core/errors/send-paused.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {backendCoversOutgoingPayment} from '@core/lnbits/outgoing-liquidity.js'
import type {AppLogger} from '../logger.js'

/** Short enough that a refilled channel is visible on the next send, long enough to spare LNbits. */
export const BACKEND_LIQUIDITY_CACHE_MS = 45_000

export const SEND_PAUSED_NO_BACKEND_LIQUIDITY = 'send_paused_no_backend_liquidity'

/**
 * The status call succeeded as a non-admin view, or LNbits refused it (401/403).
 * The wallet admin key cannot see `funding_source_balance_msat`. That is not an empty node.
 */
export class FundingSourceUnreadableError extends Error {
  constructor() {
    super('Funding source balance is not visible to this credential')
    this.name = FundingSourceUnreadableError.name
  }
}

export type PausedLiquidity = {
  reason: 'insufficient_backend_liquidity' | 'backend_liquidity_check_failed'
  amount_msat: number | null
  fee_reserve_msat: number | null
  backend_balance_msat: number | null
}

export type OutgoingLiquidityGuard = {
  assertCanPay(input: {bolt11: string; feeReserveMsat: () => Promise<number>}): Promise<void>
}

/**
 * Fail closed: a balance we could not read is treated like an empty backend.
 * Paying anyway is how a dead funding source turns into an opaque LNbits error,
 * and the pause copy is true in both cases — the wallet was not debited.
 * The error string from the funding source is never logged; NWC failures can embed the connection URL.
 */
export function createOutgoingLiquidityGuard(deps: {
  readBalanceMsat: () => Promise<number>
  log?: AppLogger
  capturePaused?: (properties: PausedLiquidity) => void
  now?: () => number
  ttlMs?: number
}): OutgoingLiquidityGuard {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? BACKEND_LIQUIDITY_CACHE_MS
  let cached: {balanceMsat: number; at: number} | null = null
  let inFlight: Promise<number> | null = null
  let notedUnreadable = false

  async function balanceMsat(): Promise<number> {
    const at = now()
    if (cached && at - cached.at < ttlMs) return cached.balanceMsat
    if (!inFlight) {
      inFlight = deps
        .readBalanceMsat()
        .then(balance => {
          if (!Number.isSafeInteger(balance) || balance < 0) {
            throw new Error('Funding source balance unavailable')
          }
          cached = {balanceMsat: balance, at: now()}
          return balance
        })
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  function pause(properties: PausedLiquidity): never {
    if (properties.reason === 'insufficient_backend_liquidity') {
      deps.log?.info(properties, 'Outgoing payment paused: backend liquidity')
    } else {
      deps.log?.warn(properties, 'Outgoing payment paused: backend liquidity check failed')
    }
    try {
      deps.capturePaused?.(properties)
    } catch {
      // Analytics must never decide whether the payment is attempted.
    }
    throw new SendPausedError({analytics: properties})
  }

  return {
    async assertCanPay(input) {
      let amountMsat: number
      try {
        amountMsat = decodeInvoice(input.bolt11).millisatoshi
      } catch {
        pause(paused('backend_liquidity_check_failed', null, null, null))
      }
      if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
        pause(paused('backend_liquidity_check_failed', null, null, null))
      }

      let backendBalance: number
      try {
        backendBalance = await balanceMsat()
      } catch (error) {
        // A wallet admin key gets 401 or a body without the balance. Pausing on that
        // would stop every send for as long as the credential stays non-admin.
        if (error instanceof FundingSourceUnreadableError) {
          if (!notedUnreadable) {
            notedUnreadable = true
            deps.log?.warn(
              'Funding source balance is not visible to this credential; outgoing payments continue',
            )
          }
          return
        }
        pause(paused('backend_liquidity_check_failed', amountMsat, null, null))
      }

      // A non-negative fee reserve cannot close a gap that is already larger than the invoice.
      if (backendBalance < amountMsat) {
        pause(paused('insufficient_backend_liquidity', amountMsat, null, backendBalance))
      }

      let feeReserveMsat: number
      try {
        feeReserveMsat = await input.feeReserveMsat()
      } catch {
        pause(paused('backend_liquidity_check_failed', amountMsat, null, backendBalance))
      }
      if (!Number.isSafeInteger(feeReserveMsat) || feeReserveMsat < 0) {
        pause(paused('backend_liquidity_check_failed', amountMsat, null, backendBalance))
      }

      if (
        !backendCoversOutgoingPayment({
          balanceMsat: backendBalance,
          amountMsat,
          feeReserveMsat,
        })
      ) {
        pause(paused('insufficient_backend_liquidity', amountMsat, feeReserveMsat, backendBalance))
      }
    },
  }
}

function paused(
  reason: PausedLiquidity['reason'],
  amountMsat: number | null,
  feeReserveMsat: number | null,
  backendBalanceMsat: number | null,
): PausedLiquidity {
  return {
    reason,
    amount_msat: amountMsat,
    fee_reserve_msat: feeReserveMsat,
    backend_balance_msat: backendBalanceMsat,
  }
}
