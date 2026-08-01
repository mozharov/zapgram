import {db} from '@infra/db/client.js'
import {conversationsTable} from '@infra/db/schema.js'
import type {Conversation, NewConversation} from '@infra/db/types.js'
import {eq} from 'drizzle-orm'

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
