import {randomUUID} from 'node:crypto'
import {decideInvoiceReuse} from '@core/subscriptions/invoice-reuse.js'
import type {AppDatabase} from '@infra/db/client.js'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {
  NewSubscriptionIntent,
  NewSubscriptionPayment,
  SubscriptionIntent,
  SubscriptionPayment,
} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, desc, eq, inArray} from 'drizzle-orm'

export const ATTEMPT_RESERVATION_TTL_MS = 5 * 60 * 1000

type IntentIdentity = Pick<NewSubscriptionIntent, 'userId' | 'chatId' | 'kind'>

export type ReserveInvoiceAttemptResult =
  | {
      action: 'reuse'
      intent: SubscriptionIntent
      attempt: SubscriptionPayment
      remainingMinutes: number
    }
  | {
      action: 'reserved'
      intent: SubscriptionIntent
      reservationId: string
      reservationExpiresAt: Date
    }
  | {
      action: 'busy'
      intent: SubscriptionIntent
      reservationExpiresAt: Date
    }
  | {action: 'closed'; intent: SubscriptionIntent}

export type FinalizeReservedAttemptData = Pick<
  NewSubscriptionPayment,
  'paymentRequest' | 'paymentHash' | 'price' | 'subscriptionType'
> & {expiresAt: Date}

export function createSubscriptionIntentRepository(database: AppDatabase) {
  function findActive(tx: AppDatabase, identity: IntentIdentity) {
    return tx
      .select()
      .from(subscriptionIntentsTable)
      .where(
        and(
          eq(subscriptionIntentsTable.userId, identity.userId),
          eq(subscriptionIntentsTable.chatId, identity.chatId),
          eq(subscriptionIntentsTable.kind, identity.kind),
          inArray(subscriptionIntentsTable.status, ['open', 'won']),
        ),
      )
      .orderBy(desc(subscriptionIntentsTable.createdAt))
      .get()
  }

  function currentAttempt(tx: AppDatabase, intentId: SubscriptionIntent['id']) {
    return tx
      .select()
      .from(subscriptionPaymentsTable)
      .where(
        and(
          eq(subscriptionPaymentsTable.intentId, intentId),
          eq(subscriptionPaymentsTable.isCurrent, true),
        ),
      )
      .orderBy(desc(subscriptionPaymentsTable.createdAt))
      .get()
  }

  function getOrCreateActive(tx: AppDatabase, identity: IntentIdentity) {
    const existing = findActive(tx, identity)
    if (existing) return existing

    tx.insert(subscriptionIntentsTable)
      .values({...identity, id: randomUUID(), status: 'open'})
      .onConflictDoNothing()
      .run()
    const created = findActive(tx, identity)
    if (!created) throw firstOrThrow([], 'active subscription intent')
    return created
  }

  return {
    async create(data: NewSubscriptionIntent) {
      return database
        .insert(subscriptionIntentsTable)
        .values({...data, id: randomUUID()})
        .returning()
        .then(rows => firstOrThrow(rows, 'subscription intent'))
    },

    async findById(id: SubscriptionIntent['id']) {
      return database.query.subscriptionIntentsTable.findFirst({
        where: eq(subscriptionIntentsTable.id, id),
      })
    },

    async getOrCreateActive(identity: IntentIdentity) {
      return database.transaction(tx => {
        const intent = getOrCreateActive(tx, identity)
        return {intent, currentAttempt: currentAttempt(tx, intent.id)}
      })
    },

    async reserveInvoiceAttempt(
      identity: IntentIdentity,
      now = new Date(),
      reservationTtlMs = ATTEMPT_RESERVATION_TTL_MS,
    ): Promise<ReserveInvoiceAttemptResult> {
      if (!Number.isFinite(reservationTtlMs) || reservationTtlMs <= 0) {
        throw new Error('Attempt reservation TTL must be positive')
      }

      return database.transaction(tx => {
        const intent = getOrCreateActive(tx, identity)
        if (intent.status !== 'open') return {action: 'closed', intent}

        const attempt = currentAttempt(tx, intent.id)
        if (attempt) {
          const reuse = decideInvoiceReuse({expiryDate: attempt.expiresAt, now})
          if (reuse.action === 'reuse') {
            return {
              action: 'reuse',
              intent,
              attempt,
              remainingMinutes: reuse.remainingMinutes,
            }
          }
        }

        if (
          intent.attemptReservationId &&
          intent.attemptReservationExpiresAt &&
          intent.attemptReservationExpiresAt.getTime() > now.getTime()
        ) {
          return {
            action: 'busy',
            intent,
            reservationExpiresAt: intent.attemptReservationExpiresAt,
          }
        }

        const reservationId = randomUUID()
        const reservationExpiresAt = new Date(now.getTime() + reservationTtlMs)
        const reserved = tx
          .update(subscriptionIntentsTable)
          .set({
            attemptReservationId: reservationId,
            attemptReservationExpiresAt: reservationExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(subscriptionIntentsTable.id, intent.id),
              eq(subscriptionIntentsTable.status, 'open'),
            ),
          )
          .returning()
          .get()
        if (!reserved) throw new Error(`Could not reserve attempt for intent ${intent.id}`)

        return {action: 'reserved', intent: reserved, reservationId, reservationExpiresAt}
      })
    },

    async finalizeReservedAttempt(
      intentId: SubscriptionIntent['id'],
      reservationId: string,
      data: FinalizeReservedAttemptData,
      now = new Date(),
    ) {
      return database.transaction(tx => {
        const intent = tx
          .select()
          .from(subscriptionIntentsTable)
          .where(
            and(
              eq(subscriptionIntentsTable.id, intentId),
              eq(subscriptionIntentsTable.status, 'open'),
              eq(subscriptionIntentsTable.attemptReservationId, reservationId),
            ),
          )
          .get()
        if (!intent) throw new Error(`Attempt reservation ${reservationId} is no longer active`)
        if (
          !intent.attemptReservationExpiresAt ||
          intent.attemptReservationExpiresAt.getTime() <= now.getTime()
        ) {
          throw new Error(`Attempt reservation ${reservationId} has expired`)
        }

        tx.update(subscriptionPaymentsTable)
          .set({isCurrent: false})
          .where(
            and(
              eq(subscriptionPaymentsTable.intentId, intent.id),
              eq(subscriptionPaymentsTable.isCurrent, true),
            ),
          )
          .run()

        const attempt = tx
          .insert(subscriptionPaymentsTable)
          .values({
            ...data,
            id: randomUUID(),
            intentId: intent.id,
            userId: intent.userId,
            chatId: intent.chatId,
            kind: intent.kind,
            isCurrent: true,
            attemptStatus: 'pending',
          })
          .returning()
          .get()

        tx.update(subscriptionIntentsTable)
          .set({
            attemptReservationId: null,
            attemptReservationExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(subscriptionIntentsTable.id, intent.id),
              eq(subscriptionIntentsTable.attemptReservationId, reservationId),
            ),
          )
          .run()

        return attempt
      })
    },

    async releaseAttemptReservation(intentId: SubscriptionIntent['id'], reservationId: string) {
      database
        .update(subscriptionIntentsTable)
        .set({
          attemptReservationId: null,
          attemptReservationExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(subscriptionIntentsTable.id, intentId),
            eq(subscriptionIntentsTable.status, 'open'),
            eq(subscriptionIntentsTable.attemptReservationId, reservationId),
          ),
        )
        .run()
    },
  }
}

export type SubscriptionIntentRepository = ReturnType<typeof createSubscriptionIntentRepository>
