import {db} from '../lib/database/database.js'
import {subscriptionPaymentsTable} from '../lib/database/schema.js'
import type {NewSubscriptionPayment} from '../lib/database/types.js'

export async function createSubscriptionPayment(data: NewSubscriptionPayment) {
  return db
    .insert(subscriptionPaymentsTable)
    .values(data)
    .returning()
    .then(rows => rows[0]!)
}
