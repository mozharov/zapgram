import {db} from '../lib/database/database.js'
import {conversationsTable} from '../lib/database/schema.js'
import {eq} from 'drizzle-orm'
import type {Conversation, NewConversation} from '../lib/database/types.js'

export async function deleteConversation(key: Conversation['key']) {
  await db.delete(conversationsTable).where(eq(conversationsTable.key, key))
}

export async function getConversation(key: Conversation['key']) {
  return db.query.conversationsTable.findFirst({where: eq(conversationsTable.key, key)})
}

export async function createOrUpdateConversation(data: NewConversation) {
  await db.insert(conversationsTable).values(data).onConflictDoUpdate({
    target: conversationsTable.key,
    set: data,
  })
}
