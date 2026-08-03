import {randomUUID} from 'node:crypto'
import type {AppDatabase} from '@infra/db/client.js'
import {subscriptionIntentsTable, subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {NewSubscriptionPayment, SubscriptionPayment} from '@infra/db/types.js'
import {and, count, desc, eq, gte, lt, sql} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

/**
 * The cron ticks every 3 minutes, so this is roughly a week of retries. Deliberately generous:
 * a payment that reaches this point has already been collected from the subscriber, so giving up
 * early would strand the chat owner's payout. Exhausted rows are never deleted — they stop being
 * retried and stay in the table for manual review.
 */
export const MAX_SETTLE_ATTEMPTS = 3360

export function createSubscriptionPaymentRepository(database: AppDatabase) {
  const settleable = lt(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS)

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
        .where(gte(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS))
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
                eq(subscriptionIntentsTable.status, 'legacy'),
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
