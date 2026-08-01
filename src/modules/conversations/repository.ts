import type {AppDatabase} from '@infra/db/client.js'
import {conversationsTable} from '@infra/db/schema.js'
import type {Conversation, NewConversation} from '@infra/db/types.js'
import {eq} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

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

export const deleteConversation = (key: Conversation['key']) =>
  getRuntime().conversations.delete(key)
export const getConversation = (key: Conversation['key']) =>
  getRuntime().conversations.findByKey(key)
export const createOrUpdateConversation = (data: NewConversation) =>
  getRuntime().conversations.createOrUpdate(data)
