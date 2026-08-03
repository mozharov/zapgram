import {randomUUID} from 'node:crypto'
import type {AppDatabase} from '@infra/db/client.js'
import {subscriptionIntentsTable} from '@infra/db/schema.js'
import type {NewSubscriptionIntent, SubscriptionIntent} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {eq} from 'drizzle-orm'

export function createSubscriptionIntentRepository(database: AppDatabase) {
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
  }
}

export type SubscriptionIntentRepository = ReturnType<typeof createSubscriptionIntentRepository>
