import {randomUUID} from 'crypto'
import {db} from '../lib/database/database.js'
import {subscriptionsTable} from '../lib/database/schema.js'
import type {NewSubscription, Subscription} from '../lib/database/types.js'
import {and, eq, lte, desc, count, gt} from 'drizzle-orm'

export async function createSubscription(data: NewSubscription) {
  return db
    .insert(subscriptionsTable)
    .values({...data, id: randomUUID()})
    .returning()
    .then(rows => rows[0]!)
}

export async function getSubscriptionByUserAndChat(
  userId: Subscription['userId'],
  chatId: Subscription['chatId'],
) {
  return db.query.subscriptionsTable.findFirst({
    where: and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.chatId, chatId)),
  })
}

export async function updateSubscription(id: Subscription['id'], data: Partial<Subscription>) {
  return db
    .update(subscriptionsTable)
    .set(data)
    .where(eq(subscriptionsTable.id, id))
    .returning()
    .then(rows => rows[0]!)
}

export async function getExpiredSubscriptions(limit?: number, offset?: number, date?: Date) {
  return db.query.subscriptionsTable.findMany({
    where: lte(subscriptionsTable.endsAt, date ?? new Date()),
    orderBy: desc(subscriptionsTable.id),
    limit,
    offset,
  })
}

export async function deleteSubscription(id: Subscription['id'], endsAt?: Date) {
  await db
    .delete(subscriptionsTable)
    .where(and(eq(subscriptionsTable.id, id), lte(subscriptionsTable.endsAt, endsAt ?? new Date())))
}

export async function countExpiredSubscriptions(date?: Date) {
  return db
    .select({count: count()})
    .from(subscriptionsTable)
    .where(lte(subscriptionsTable.endsAt, date ?? new Date()))
    .then(rows => rows[0]!.count)
}

/**
 * Get subscriptions that are about to expire and haven't had notifications sent yet
 */
export async function getSubscriptionsExpiringWithin(
  maxExpiryDate: Date,
  minExpiryDate: Date,
  limit: number,
  offset: number,
): Promise<Subscription[]> {
  return db.query.subscriptionsTable.findMany({
    where: and(
      lte(subscriptionsTable.endsAt, maxExpiryDate),
      gt(subscriptionsTable.endsAt, minExpiryDate),
      eq(subscriptionsTable.notificationSent, false),
    ),
    limit,
    offset,
  })
}

export async function countSubscriptionsExpiringWithin(maxExpiryDate: Date, minExpiryDate: Date) {
  return db
    .select({count: count()})
    .from(subscriptionsTable)
    .where(
      and(
        lte(subscriptionsTable.endsAt, maxExpiryDate),
        gt(subscriptionsTable.endsAt, minExpiryDate),
      ),
    )
    .then(rows => rows[0]!.count)
}
