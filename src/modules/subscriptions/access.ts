import {randomUUID} from 'node:crypto'
import {grantSubscriptionAccessIfNeeded} from '@core/subscriptions/grant.js'
import type {AppDatabase} from '@infra/db/client.js'
import {subscriptionPaymentsTable, subscriptionsTable} from '@infra/db/schema.js'
import type {SubscriptionPayment} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import {and, eq} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

/**
 * Read the current subscription, create/extend it, and stamp `settledAt` in a single transaction.
 * Without the transaction a crash between the two writes would leave the payment unsettled and the
 * subscription already extended, so the next cron tick would extend it a second time.
 *
 * Synchronous on purpose — see the note in `grantSubscriptionAccessIfNeeded`.
 */
export function createGrantSubscriptionAccess(database: AppDatabase, log: AppLogger) {
  return function grantSubscriptionAccess(payment: SubscriptionPayment, now: Date = new Date()) {
    return database.transaction(tx =>
      grantSubscriptionAccessIfNeeded(
        payment,
        {
          getSubscriptionByUserAndChat: (userId, chatId) =>
            tx
              .select()
              .from(subscriptionsTable)
              .where(
                and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.chatId, chatId)),
              )
              .get(),
          createSubscription: data => {
            tx.insert(subscriptionsTable)
              .values({...data, id: randomUUID()})
              .run()
          },
          updateSubscription: (id, data) => {
            tx.update(subscriptionsTable).set(data).where(eq(subscriptionsTable.id, id)).run()
          },
          markPaymentSettled: (paymentId, settledAt) => {
            tx.update(subscriptionPaymentsTable)
              .set({settledAt})
              .where(eq(subscriptionPaymentsTable.id, paymentId))
              .run()
          },
          log,
        },
        now,
      ),
    )
  }
}

/** Leaf convenience — uses bootstrap runtime. */
export function grantSubscriptionAccess(payment: SubscriptionPayment, now?: Date) {
  return getRuntime().grantAccess(payment, now)
}
