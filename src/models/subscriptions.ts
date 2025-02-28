import {randomUUID} from 'crypto'
import {db} from '../lib/database/database.js'
import {subscriptionsTable} from '../lib/database/schema.js'
import type {NewSubscription, Subscription} from '../lib/database/types.js'
import {and, eq} from 'drizzle-orm'

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
