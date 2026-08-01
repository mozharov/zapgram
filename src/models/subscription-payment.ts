import {randomUUID} from 'node:crypto'
import {db} from '@infra/db/client.js'
import {subscriptionPaymentsTable} from '@infra/db/schema.js'
import type {NewSubscriptionPayment, SubscriptionPayment} from '@infra/db/types.js'
import {and, count, desc, eq, gte, lt, sql} from 'drizzle-orm'

/**
 * The cron ticks every 3 minutes, so this is roughly a week of retries. Deliberately generous:
 * a payment that reaches this point has already been collected from the subscriber, so giving up
 * early would strand the chat owner's payout. Exhausted rows are never deleted — they stop being
 * retried and stay in the table for manual review.
 */
export const MAX_SETTLE_ATTEMPTS = 3360

/** Payments the cron is still allowed to work on. */
const settleable = lt(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS)

export async function createSubscriptionPayment(data: NewSubscriptionPayment) {
  return db
    .insert(subscriptionPaymentsTable)
    .values({...data, id: randomUUID()})
    .returning()
    .then(rows => {
      const row = rows[0]
      if (row === undefined) throw new Error('Failed to create subscription payment')
      return row
    })
}

export async function countSubscriptionPayments() {
  return db
    .select({count: count()})
    .from(subscriptionPaymentsTable)
    .where(settleable)
    .then(rows => rows[0]?.count ?? 0)
}

/** Payments that ran out of settle attempts and now need a human to look at them. */
export async function countExhaustedSubscriptionPayments() {
  return db
    .select({count: count()})
    .from(subscriptionPaymentsTable)
    .where(gte(subscriptionPaymentsTable.settleAttempts, MAX_SETTLE_ATTEMPTS))
    .then(rows => rows[0]?.count ?? 0)
}

export async function getSubscriptionPayments(limit?: number, offset?: number) {
  return db.query.subscriptionPaymentsTable.findMany({
    limit,
    offset,
    where: settleable,
    orderBy: desc(subscriptionPaymentsTable.id),
  })
}

/** Must be persisted before the payout invoice is paid — see distributeSubscriptionPaymentOnce. */
export async function recordPayoutInvoice(
  id: SubscriptionPayment['id'],
  payoutHash: NonNullable<SubscriptionPayment['payoutHash']>,
) {
  await db
    .update(subscriptionPaymentsTable)
    .set({payoutHash})
    .where(eq(subscriptionPaymentsTable.id, id))
}

/** Same ordering requirement as recordPayoutInvoice, for the fee-collection transfer. */
export async function recordFeePayoutInvoice(
  id: SubscriptionPayment['id'],
  feePayoutHash: NonNullable<SubscriptionPayment['feePayoutHash']>,
) {
  await db
    .update(subscriptionPaymentsTable)
    .set({feePayoutHash})
    .where(eq(subscriptionPaymentsTable.id, id))
}

/**
 * An in-flight payment for this subscription, if any. Auto-renewal checks this before charging the
 * subscriber again: an existing row means a previous attempt is still owned by the settle cron.
 */
export async function getPendingPaymentForSubscription(
  userId: SubscriptionPayment['userId'],
  chatId: SubscriptionPayment['chatId'],
) {
  return db.query.subscriptionPaymentsTable.findFirst({
    where: and(
      eq(subscriptionPaymentsTable.userId, userId),
      eq(subscriptionPaymentsTable.chatId, chatId),
    ),
  })
}

export async function recordSettleAttempt(id: SubscriptionPayment['id']) {
  await db
    .update(subscriptionPaymentsTable)
    .set({settleAttempts: sql`${subscriptionPaymentsTable.settleAttempts} + 1`})
    .where(eq(subscriptionPaymentsTable.id, id))
}

export async function deleteSubscriptionPayment(id: SubscriptionPayment['id']) {
  await db.delete(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, id))
}

export async function getSubscriptionPayment(id: SubscriptionPayment['id']) {
  return db.query.subscriptionPaymentsTable.findFirst({
    where: eq(subscriptionPaymentsTable.id, id),
  })
}
