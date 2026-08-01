import type {AppDatabase} from '@infra/db/client.js'
import {db as defaultDb} from '@infra/db/client.js'
import {conversationsTable} from '@infra/db/schema.js'
import type {Conversation, NewConversation} from '@infra/db/types.js'
import {eq} from 'drizzle-orm'

export function createConversationRepository(database: AppDatabase) {
  return {
    async delete(key: Conversation['key']) {
      await database.delete(conversationsTable).where(eq(conversationsTable.key, key))
    },

    async findByKey(key: Conversation['key']) {
      return database.query.conversationsTable.findFirst({
        where: eq(conversationsTable.key, key),
      })
    },

    async createOrUpdate(data: NewConversation) {
      await database.insert(conversationsTable).values(data).onConflictDoUpdate({
        target: conversationsTable.key,
        set: data,
      })
    },
  }
}

export type ConversationRepository = ReturnType<typeof createConversationRepository>

/** Legacy singleton — removed in step 11. */
export const conversationsRepository = createConversationRepository(defaultDb)

export const deleteConversation = (key: Conversation['key']) => conversationsRepository.delete(key)
export const getConversation = (key: Conversation['key']) => conversationsRepository.findByKey(key)
export const createOrUpdateConversation = (data: NewConversation) =>
  conversationsRepository.createOrUpdate(data)
