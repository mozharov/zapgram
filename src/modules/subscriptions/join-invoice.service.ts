import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {decideInvoiceReuse} from '@core/subscriptions/invoice-reuse.js'
import type {SubscriptionPayment} from '@infra/db/types.js'
import type {FinalizeReservedAttemptData, ReserveInvoiceAttemptResult} from './intent-repository.js'

const BUSY_RETRY_DELAY_MS = 25
const BUSY_WAIT_TIMEOUT_MS = 10_000

type JoinInvoiceIdentity = {
  userId: number
  chatId: number
  kind: 'join'
}

type JoinInvoiceRequest = JoinInvoiceIdentity & {
  price: number
  subscriptionType: 'one_time' | 'monthly'
}

type JoinInvoiceResult = {
  attempt: SubscriptionPayment
  remainingMinutes: number
  reused: boolean
}

type JoinInvoiceServiceDeps = {
  reserveInvoiceAttempt: (
    identity: JoinInvoiceRequest,
    now: Date,
  ) => Promise<ReserveInvoiceAttemptResult>
  finalizeReservedAttempt: (
    intentId: string,
    reservationId: string,
    data: FinalizeReservedAttemptData,
    now: Date,
  ) => Promise<SubscriptionPayment>
  releaseAttemptReservation: (intentId: string, reservationId: string) => Promise<void>
  createInvoice: (
    sats: number,
    expirySeconds: number,
  ) => Promise<{payment_hash: string; bolt11: string}>
  invoiceExpirySeconds: number
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
}

export function createJoinInvoiceService(deps: JoinInvoiceServiceDeps) {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? (milliseconds => Bun.sleep(milliseconds))
  const inFlight = new Map<string, Promise<JoinInvoiceResult | undefined>>()

  return {
    getOrCreate(request: JoinInvoiceRequest): Promise<JoinInvoiceResult | undefined> {
      const key = `${request.userId}:${request.chatId}:${request.kind}`
      const existing = inFlight.get(key)
      if (existing) return existing

      const operation = getOrCreate(request)
      inFlight.set(key, operation)
      operation.then(
        () => {
          if (inFlight.get(key) === operation) inFlight.delete(key)
        },
        () => {
          if (inFlight.get(key) === operation) inFlight.delete(key)
        },
      )
      return operation
    },
  }

  async function getOrCreate(request: JoinInvoiceRequest): Promise<JoinInvoiceResult | undefined> {
    const startedAt = now().getTime()

    while (true) {
      const reservation = await deps.reserveInvoiceAttempt(request, now())
      if (reservation.action === 'closed') return undefined
      if (reservation.action === 'reuse') {
        return {
          attempt: reservation.attempt,
          remainingMinutes: reservation.remainingMinutes,
          reused: true,
        }
      }
      if (reservation.action === 'busy') {
        if (now().getTime() - startedAt >= BUSY_WAIT_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for invoice attempt for intent ${reservation.intent.id}`,
          )
        }
        await sleep(BUSY_RETRY_DELAY_MS)
        continue
      }

      return mintReservedAttempt(request, reservation)
    }
  }

  async function mintReservedAttempt(
    request: JoinInvoiceRequest,
    reservation: Extract<ReserveInvoiceAttemptResult, {action: 'reserved'}>,
  ): Promise<JoinInvoiceResult> {
    let finalized = false
    try {
      const invoice = await deps.createInvoice(request.price, deps.invoiceExpirySeconds)
      const decoded = decodeInvoice(invoice.bolt11)
      if (!decoded.expiryDate) throw new Error('Minted subscription invoice has no expiry')

      const finalizedAt = now()
      const reuse = decideInvoiceReuse({expiryDate: decoded.expiryDate, now: finalizedAt})
      if (reuse.action !== 'reuse') {
        throw new Error(`Minted subscription invoice is not safely reusable: ${reuse.reason}`)
      }

      const attempt = await deps.finalizeReservedAttempt(
        reservation.intent.id,
        reservation.reservationId,
        {
          paymentRequest: invoice.bolt11,
          paymentHash: invoice.payment_hash,
          price: request.price,
          subscriptionType: request.subscriptionType,
          expiresAt: decoded.expiryDate,
        },
        finalizedAt,
      )
      finalized = true
      return {attempt, remainingMinutes: reuse.remainingMinutes, reused: false}
    } finally {
      if (!finalized) {
        await deps.releaseAttemptReservation(reservation.intent.id, reservation.reservationId)
      }
    }
  }
}

export type JoinInvoiceService = ReturnType<typeof createJoinInvoiceService>
