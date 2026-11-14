import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {backendCoversOutgoingPayment} from '@core/lnbits/outgoing-liquidity.js'
import {HTTPError} from 'got'
import type {AppLogger} from '../logger.js'

/** Short enough that a refilled channel is visible on the next send, long enough to spare LNbits. */
export const BACKEND_LIQUIDITY_CACHE_MS = 45_000

/** A failed status read stays fail-open, but the next pay must not wait on the same hang. */
export const BACKEND_LIQUIDITY_FAILURE_CACHE_MS = 5_000

export const SEND_PAUSED_NO_BACKEND_LIQUIDITY = 'send_paused_no_backend_liquidity'
export const BACKEND_LIQUIDITY_CHECK_FAILED = 'backend_liquidity_check_failed'
export const BACKEND_LIQUIDITY_MODE = 'backend_liquidity_mode'

/**
 * Why a check did not produce a usable balance. The payment still proceeds.
 * Values are codes, never response bodies: an NWC error string can contain the connection URL.
 */
export type LiquidityCheckReason =
  | 'unauthorized'
  | 'not_found'
  | 'http_error'
  | 'timeout'
  | 'funding_source_error'
  | 'balance_missing'
  | 'invalid_response'
  | 'classify_failed'
  | 'fee_reserve'
  | 'invalid_invoice'

export type BalanceRead =
  | {ok: true; balanceMsat: number}
  | {ok: false; reason: LiquidityCheckReason}

export type InvoiceOrigin = 'internal' | 'external' | 'unknown'

export type ClassifyProbe = 'ok' | 'failed' | 'missing_bearer'

export type LiquidityMode = {
  mode: 'active' | 'disabled'
  reason: 'ok' | 'missing_bearer' | LiquidityCheckReason | 'check_failed'
  /** Whether the admin payment list used to classify invoices answered. */
  classify: ClassifyProbe
}

/** Amount held against the cached balance until the pay settles or is released. */
export type LiquidityHold = {msat: number; generation: number; paymentHash: string}

export type OutgoingLiquidityGuard = {
  assertCanPay(input: {
    bolt11: string
    payerWalletId?: string
    feeReserveMsat: () => Promise<number>
  }): Promise<LiquidityHold | undefined>
  /** Drop a hold after the pay succeeded. The cache already counts it as spent. */
  settle(hold: LiquidityHold): Promise<void>
  /** Put a hold back after LNbits refused the pay and this cache generation is still current. */
  release(hold: LiquidityHold): Promise<void>
}

/**
 * True only when LNbits finished the request and the payment did not leave.
 * A 4xx is a refusal before pay. A 520 counts only when its body says `failed`.
 * Any other 520, a timeout, or a 5xx may still have spent the backend.
 */
export function payLeftBackendUnspent(error: unknown): boolean {
  if (error instanceof InvoiceAlreadyPaidError || error instanceof InsufficientFundsError) {
    return true
  }
  if (!(error instanceof HTTPError)) return false
  const status = error.response.statusCode
  if (status >= 400 && status < 500) return true
  if (status !== 520) return false
  const body = error.response.body
  if (!body || typeof body !== 'object') return false
  return (body as {status?: unknown}).status === 'failed'
}

/**
 * Pause only an external payment whose funding-source balance was actually read and is short.
 * Internal invoices never touch the funding source. Any failed or unreadable check lets the
 * payment continue, the way it did before the check existed.
 */
export function createOutgoingLiquidityGuard(deps: {
  classifyInvoice: (bolt11: string, payerWalletId?: string) => Promise<InvoiceOrigin>
  readBalance: () => Promise<BalanceRead>
  log?: AppLogger
  capturePaused?: (properties: {
    amount_msat: number
    fee_reserve_msat: number | null
    backend_balance_msat: number
  }) => void
  captureCheckFailed?: (properties: {reason: LiquidityCheckReason}) => void
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
}): OutgoingLiquidityGuard {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? BACKEND_LIQUIDITY_CACHE_MS
  const failureTtlMs = deps.failureTtlMs ?? BACKEND_LIQUIDITY_FAILURE_CACHE_MS
  let generation = 0
  let cached: {balanceMsat: number; at: number; generation: number} | null = null
  let failedRead: {reason: LiquidityCheckReason; at: number} | null = null
  let inFlight: Promise<BalanceRead> | null = null
  let tail: Promise<unknown> = Promise.resolve()
  const outstanding = new Map<string, LiquidityHold>()
  const lastFailureEventAt = new Map<string, number>()

  function noteFailure(reason: LiquidityCheckReason): void {
    const at = now()
    const previous = lastFailureEventAt.get(reason)
    if (previous !== undefined && at - previous < ttlMs) return
    lastFailureEventAt.set(reason, at)
    deps.log?.warn({reason}, 'Backend liquidity check failed; payment continues')
    try {
      deps.captureCheckFailed?.({reason})
    } catch {
      // Analytics must never decide whether the payment is attempted.
    }
  }

  function reservedMsat(): number {
    let sum = 0
    for (const hold of outstanding.values()) sum += hold.msat
    return sum
  }

  async function balance(): Promise<BalanceRead> {
    const at = now()
    if (cached && at - cached.at < ttlMs) return {ok: true, balanceMsat: cached.balanceMsat}
    if (failedRead && at - failedRead.at < failureTtlMs) {
      return {ok: false, reason: failedRead.reason}
    }
    if (!inFlight) {
      inFlight = deps
        .readBalance()
        .then(read => {
          if (read.ok) {
            generation += 1
            // A fresh server balance does not include pays still in flight. Keep those holds.
            for (const hold of outstanding.values()) hold.generation = generation
            const available = read.balanceMsat - reservedMsat()
            cached = {
              balanceMsat: available > 0 ? available : 0,
              at: now(),
              generation,
            }
            failedRead = null
            return {ok: true as const, balanceMsat: cached.balanceMsat}
          }
          failedRead = {reason: read.reason, at: now()}
          return read
        })
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  function pause(
    amountMsat: number,
    feeReserveMsat: number | null,
    backendBalanceMsat: number,
  ): never {
    const properties = {
      amount_msat: amountMsat,
      fee_reserve_msat: feeReserveMsat,
      backend_balance_msat: backendBalanceMsat,
    }
    deps.log?.info(properties, 'Outgoing payment paused: backend liquidity')
    try {
      deps.capturePaused?.(properties)
    } catch {
      // Analytics must never decide whether the payment is attempted.
    }
    throw new SendPausedError({analytics: properties})
  }

  async function assertExternal(
    bolt11: string,
    feeReserveMsat: () => Promise<number>,
  ): Promise<LiquidityHold | undefined> {
    let amountMsat: number
    let paymentHash: string
    try {
      const decoded = decodeInvoice(bolt11)
      amountMsat = decoded.millisatoshi
      paymentHash = decoded.paymentHash.toLowerCase()
    } catch {
      noteFailure('invalid_invoice')
      return
    }
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0 || !paymentHash) {
      noteFailure('invalid_invoice')
      return
    }
    // A second pay of the same invoice is already reserved. Subtracting again pauses the next send.
    if (outstanding.has(paymentHash)) return

    const read = await balance()
    if (!read.ok) {
      noteFailure(read.reason)
      return
    }

    // A non-negative reserve cannot make a balance that is already under the invoice enough.
    if (read.balanceMsat < amountMsat) {
      pause(amountMsat, null, read.balanceMsat)
    }

    let reserveMsat: number
    try {
      reserveMsat = await feeReserveMsat()
    } catch {
      noteFailure('fee_reserve')
      return
    }
    if (!Number.isSafeInteger(reserveMsat) || reserveMsat < 0) {
      noteFailure('fee_reserve')
      return
    }
    if (
      !backendCoversOutgoingPayment({
        balanceMsat: read.balanceMsat,
        amountMsat,
        feeReserveMsat: reserveMsat,
      })
    ) {
      pause(amountMsat, reserveMsat, read.balanceMsat)
    }

    // Hold the amount against this cache generation. A later re-read replaces the generation,
    // so releasing a failed pay cannot add the amount on top of a fresh server balance.
    if (!cached) return
    const needed = amountMsat + reserveMsat
    const hold = {msat: needed, generation: cached.generation, paymentHash}
    outstanding.set(paymentHash, hold)
    cached = {...cached, balanceMsat: Math.max(0, cached.balanceMsat - needed)}
    return hold
  }

  function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const settled = tail.then(
      () => undefined,
      () => undefined,
    )
    const run = settled.then(task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    async assertCanPay(input) {
      // Classification stays outside the pay queue. An internal transfer must not wait
      // while an external pay is stuck on a hung funding-source status.
      const origin = await deps.classifyInvoice(input.bolt11, input.payerWalletId)
      if (origin === 'internal') return
      if (origin === 'unknown') {
        noteFailure('classify_failed')
        return
      }
      // A previous pause rejects the chain. Swallow it so the next payment is still checked.
      return enqueue(() => {
        return assertExternal(input.bolt11, input.feeReserveMsat)
      })
    },
    settle(hold) {
      return enqueue(() => {
        outstanding.delete(hold.paymentHash)
      })
    },
    release(hold) {
      return enqueue(() => {
        const current = outstanding.get(hold.paymentHash)
        if (!current) return
        outstanding.delete(hold.paymentHash)
        if (!cached || cached.generation !== current.generation) return
        cached = {...cached, balanceMsat: cached.balanceMsat + current.msat}
      })
    },
  }
}

/** One startup sample. A thrown read must not take the process down. */
export async function probeFundingSource(input: {
  hasBearer: boolean
  read: () => Promise<BalanceRead>
  probeClassify: () => Promise<boolean>
}): Promise<LiquidityMode> {
  if (!input.hasBearer) {
    return {mode: 'disabled', reason: 'missing_bearer', classify: 'missing_bearer'}
  }
  let classify: ClassifyProbe = 'failed'
  try {
    if (await input.probeClassify()) classify = 'ok'
  } catch {
    classify = 'failed'
  }
  try {
    const read = await input.read()
    if (read.ok) return {mode: 'active', reason: 'ok', classify}
    return {mode: 'disabled', reason: read.reason, classify}
  } catch {
    return {mode: 'disabled', reason: 'check_failed', classify}
  }
}
