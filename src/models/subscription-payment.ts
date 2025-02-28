import {randomUUID} from 'crypto'
import {db} from '../lib/database/database.js'
import {subscriptionPaymentsTable} from '../lib/database/schema.js'
import type {NewSubscriptionPayment, SubscriptionPayment} from '../lib/database/types.js'
import {count, eq} from 'drizzle-orm'

export async function createSubscriptionPayment(data: NewSubscriptionPayment) {
  return db
    .insert(subscriptionPaymentsTable)
    .values({...data, id: randomUUID()})
    .returning()
    .then(rows => rows[0]!)
}

export async function countSubscriptionPayments() {
  return db
    .select({count: count()})
    .from(subscriptionPaymentsTable)
    .then(rows => rows[0]!.count)
}

export async function getSubscriptionPayments(limit?: number, offset?: number) {
  return db.query.subscriptionPaymentsTable.findMany({
    limit,
    offset,
  })
}

export async function deleteSubscriptionPayment(id: SubscriptionPayment['id']) {
  await db.delete(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, id))
}
