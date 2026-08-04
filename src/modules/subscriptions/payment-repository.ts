import {randomUUID} from 'node:crypto'
import {classifyPaidAttempt, type PaidAttemptOutcome} from '@core/subscriptions/payment-attempt.js'
import type {AppDatabase} from '@infra/db/client.js'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {NewSubscriptionPayment, SubscriptionPayment} from '@infra/db/types.js'
import {and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

/**
 * The cron ticks every 3 minutes, so this is roughly a week of retries. Deliberately generous:
 * a payment that reaches this point has already been collected from the subscriber, so giving up
 * early would strand the chat owner's payout. Exhausted rows are never deleted — they stop being
 * retried and stay in the table for manual review.
 */
export const MAX_SETTLE_ATTEMPTS = 3360

export function createSubscriptionPaymentRepository(database: AppDatabase) {
  const pending = eq(subscriptionPaymentsTable.attemptStatus, 'pending')
  const settleable = and(pending, lt(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS))

  return {
    async create(data: NewSubscriptionPayment) {
      const paymentId = randomUUID()
      const intentId = data.intentId ?? paymentId
      return database.transaction(tx => {
        // Compatibility bridge for producers that move to shared open intents in stage C.
        if (!data.intentId) {
          tx.insert(subscriptionIntentsTable)
            .values({
              id: intentId,
              userId: data.userId,
              chatId: data.chatId,
              kind: data.kind ?? 'join',
              status: 'legacy',
            })
            .run()
        } else {
          const intent = tx
            .select({
              userId: subscriptionIntentsTable.userId,
              chatId: subscriptionIntentsTable.chatId,
              kind: subscriptionIntentsTable.kind,
            })
            .from(subscriptionIntentsTable)
            .where(eq(subscriptionIntentsTable.id, intentId))
            .get()
          if (
            !intent ||
            intent.userId !== data.userId ||
            intent.chatId !== data.chatId ||
            intent.kind !== (data.kind ?? 'join')
          ) {
            throw new Error('Subscription payment does not match its intent')
          }
        }
        return tx
          .insert(subscriptionPaymentsTable)
          .values({...data, id: paymentId, intentId})
          .returning()
          .get()
      })
    },

    async countSettleable() {
      return database
        .select({count: count()})
        .from(subscriptionPaymentsTable)
        .where(settleable)
        .then(rows => rows[0]?.count ?? 0)
    },

    /** Payments that ran out of settle attempts and now need a human to look at them. */
    async countExhausted() {
      return database
        .select({count: count()})
        .from(subscriptionPaymentsTable)
        .where(and(pending, gte(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS)))
        .then(rows => rows[0]?.count ?? 0)
    },

    async getSettleable(limit?: number, offset?: number) {
      return database.query.subscriptionPaymentsTable.findMany({
        limit,
        offset,
        where: settleable,
        orderBy: desc(subscriptionPaymentsTable.id),
      })
    },

    /** Must be persisted before the payout invoice is paid — see settle.service distributeOnce. */
    async recordPayoutInvoice(
      id: SubscriptionPayment['id'],
      payoutHash: NonNullable<SubscriptionPayment['payoutHash']>,
    ) {
      await database
        .update(subscriptionPaymentsTable)
        .set({payoutHash})
        .where(eq(subscriptionPaymentsTable.id, id))
    },

    /** Same ordering requirement as recordPayoutInvoice, for the fee-collection transfer. */
    async recordFeePayoutInvoice(
      id: SubscriptionPayment['id'],
      feePayoutHash: NonNullable<SubscriptionPayment['feePayoutHash']>,
    ) {
      await database
        .update(subscriptionPaymentsTable)
        .set({feePayoutHash})
        .where(eq(subscriptionPaymentsTable.id, id))
    },

    /** Must be persisted before the refund invoice is paid — see settle.service refundDuplicate. */
    async recordRefundInvoice(
      id: SubscriptionPayment['id'],
      refundPayoutHash: NonNullable<SubscriptionPayment['refundPayoutHash']>,
    ) {
      await database
        .update(subscriptionPaymentsTable)
        .set({refundPayoutHash})
        .where(eq(subscriptionPaymentsTable.id, id))
    },

    async claimPaidAttempt(
      id: SubscriptionPayment['id'],
      claimedAt = new Date(),
    ): Promise<PaidAttemptOutcome> {
      return database.transaction(tx => {
        const attempt = tx
          .select({
            id: subscriptionPaymentsTable.id,
            intentId: subscriptionPaymentsTable.intentId,
            attemptStatus: subscriptionPaymentsTable.attemptStatus,
          })
          .from(subscriptionPaymentsTable)
          .where(eq(subscriptionPaymentsTable.id, id))
          .get()
        if (!attempt) throw new Error(`Subscription payment ${id} not found`)

        let intent = tx
          .select()
          .from(subscriptionIntentsTable)
          .where(eq(subscriptionIntentsTable.id, attempt.intentId))
          .get()
        if (!intent) throw new Error(`Subscription intent ${attempt.intentId} not found`)

        let outcome = classifyPaidAttempt({
          attemptId: attempt.id,
          winnerAttemptId: intent.winnerAttemptId,
          attemptProcessed: attempt.attemptStatus === 'processed',
        })
        if (outcome !== 'winner' || intent.winnerAttemptId !== null) return outcome

        const claimed = tx
          .update(subscriptionIntentsTable)
          .set({
            status: 'won',
            winnerAttemptId: attempt.id,
            attemptReservationId: null,
            attemptReservationExpiresAt: null,
            updatedAt: claimedAt,
          })
          .where(
            and(
              eq(subscriptionIntentsTable.id, intent.id),
              inArray(subscriptionIntentsTable.status, ['legacy', 'open']),
              isNull(subscriptionIntentsTable.winnerAttemptId),
            ),
          )
          .returning({id: subscriptionIntentsTable.id})
          .get()
        if (claimed) return 'winner'

        intent = tx
          .select()
          .from(subscriptionIntentsTable)
          .where(eq(subscriptionIntentsTable.id, attempt.intentId))
          .get()
        if (!intent) throw new Error(`Subscription intent ${attempt.intentId} not found`)
        outcome = classifyPaidAttempt({
          attemptId: attempt.id,
          winnerAttemptId: intent.winnerAttemptId,
          attemptProcessed: attempt.attemptStatus === 'processed',
        })
        return outcome
      })
    },

    async markWinnerCompleted(id: SubscriptionPayment['id'], processedAt = new Date()) {
      database.transaction(tx => {
        const attempt = tx
          .select({intentId: subscriptionPaymentsTable.intentId})
          .from(subscriptionPaymentsTable)
          .where(eq(subscriptionPaymentsTable.id, id))
          .get()
        if (!attempt) throw new Error(`Subscription payment ${id} not found`)

        // Compatibility producers create a one-to-one legacy intent with the same id as its only
        // payment. Keep their historical cleanup behavior while shared intents retain their audit.
        if (attempt.intentId === id) {
          const deleted = tx
            .delete(subscriptionIntentsTable)
            .where(
              and(
                eq(subscriptionIntentsTable.id, attempt.intentId),
                eq(subscriptionIntentsTable.status, 'won'),
                eq(subscriptionIntentsTable.winnerAttemptId, id),
              ),
            )
            .returning({id: subscriptionIntentsTable.id})
            .get()
          if (!deleted) throw new Error(`Subscription payment ${id} is not the claimed winner`)
          return
        }

        const completedAttempt = tx
          .update(subscriptionPaymentsTable)
          .set({attemptStatus: 'processed', processedAt, isCurrent: false})
          .where(eq(subscriptionPaymentsTable.id, id))
          .returning({id: subscriptionPaymentsTable.id})
          .get()
        const completedIntent = tx
          .update(subscriptionIntentsTable)
          .set({status: 'completed', updatedAt: processedAt})
          .where(
            and(
              eq(subscriptionIntentsTable.id, attempt.intentId),
              eq(subscriptionIntentsTable.winnerAttemptId, id),
              inArray(subscriptionIntentsTable.status, ['won', 'completed']),
            ),
          )
          .returning({id: subscriptionIntentsTable.id})
          .get()
        if (!completedAttempt || !completedIntent) {
          throw new Error(`Subscription payment ${id} is not the claimed winner`)
        }
      })
    },

    async markRefundCredited(id: SubscriptionPayment['id'], refundedAt = new Date()) {
      const result = await database
        .update(subscriptionPaymentsTable)
        .set({
          attemptStatus: 'processed',
          processedAt: refundedAt,
          refundedAt,
          isCurrent: false,
        })
        .where(
          and(
            eq(subscriptionPaymentsTable.id, id),
            isNotNull(subscriptionPaymentsTable.refundPayoutHash),
          ),
        )
        .returning({id: subscriptionPaymentsTable.id})
        .get()
      if (!result) {
        throw new Error(`Subscription payment ${id} has no persisted refund payout`)
      }
    },

    /**
     * An in-flight payment for this subscription, if any. Auto-renewal checks this before charging
     * the subscriber again: an existing row means a previous attempt is still owned by the settle cron.
     */
    async getPendingForSubscription(
      userId: SubscriptionPayment['userId'],
      chatId: SubscriptionPayment['chatId'],
    ) {
      return database.query.subscriptionPaymentsTable.findFirst({
        where: and(
          eq(subscriptionPaymentsTable.userId, userId),
          eq(subscriptionPaymentsTable.chatId, chatId),
          pending,
        ),
      })
    },

    async recordSettleAttempt(id: SubscriptionPayment['id']) {
      await database
        .update(subscriptionPaymentsTable)
        .set({settleAttempts: sql`${subscriptionPaymentsTable.settleAttempts} + 1`})
        .where(eq(subscriptionPaymentsTable.id, id))
    },

    async delete(id: SubscriptionPayment['id']) {
      database.transaction(tx => {
        const payment = tx
          .select({intentId: subscriptionPaymentsTable.intentId})
          .from(subscriptionPaymentsTable)
          .where(eq(subscriptionPaymentsTable.id, id))
          .get()
        tx.delete(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, id)).run()
        const remainingAttempts = payment
          ? (tx
              .select({count: count()})
              .from(subscriptionPaymentsTable)
              .where(eq(subscriptionPaymentsTable.intentId, payment.intentId))
              .get()?.count ?? 0)
          : 0
        if (payment && remainingAttempts === 0) {
          tx.delete(subscriptionIntentsTable)
            .where(
              and(
                eq(subscriptionIntentsTable.id, payment.intentId),
                inArray(subscriptionIntentsTable.status, ['legacy', 'open']),
              ),
            )
            .run()
        }
      })
    },

    async findById(id: SubscriptionPayment['id']) {
      return database.query.subscriptionPaymentsTable.findFirst({
        where: eq(subscriptionPaymentsTable.id, id),
      })
    },

    async findByPaymentHash(paymentHash: SubscriptionPayment['paymentHash']) {
      return database.query.subscriptionPaymentsTable.findFirst({
        where: eq(subscriptionPaymentsTable.paymentHash, paymentHash),
      })
    },
  }
}

export type SubscriptionPaymentRepository = ReturnType<typeof createSubscriptionPaymentRepository>

export const createSubscriptionPayment = (data: NewSubscriptionPayment) =>
  getRuntime().payments.create(data)
export const countSubscriptionPayments = () => getRuntime().payments.countSettleable()
export const countExhaustedSubscriptionPayments = () => getRuntime().payments.countExhausted()
export const getSubscriptionPayments = (limit?: number, offset?: number) =>
  getRuntime().payments.getSettleable(limit, offset)
export const recordPayoutInvoice = (
  id: SubscriptionPayment['id'],
  payoutHash: NonNullable<SubscriptionPayment['payoutHash']>,
) => getRuntime().payments.recordPayoutInvoice(id, payoutHash)
export const recordFeePayoutInvoice = (
  id: SubscriptionPayment['id'],
  feePayoutHash: NonNullable<SubscriptionPayment['feePayoutHash']>,
) => getRuntime().payments.recordFeePayoutInvoice(id, feePayoutHash)
export const getPendingPaymentForSubscription = (
  userId: SubscriptionPayment['userId'],
  chatId: SubscriptionPayment['chatId'],
) => getRuntime().payments.getPendingForSubscription(userId, chatId)
export const recordSettleAttempt = (id: SubscriptionPayment['id']) =>
  getRuntime().payments.recordSettleAttempt(id)
export const deleteSubscriptionPayment = (id: SubscriptionPayment['id']) =>
  getRuntime().payments.delete(id)
export const getSubscriptionPayment = (id: SubscriptionPayment['id']) =>
  getRuntime().payments.findById(id)
export const getSubscriptionPaymentByHash = (paymentHash: SubscriptionPayment['paymentHash']) =>
  getRuntime().payments.findByPaymentHash(paymentHash)
