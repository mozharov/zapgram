import {and, count, desc, eq, isNull, ne} from 'drizzle-orm'
import {db} from '../lib/database/database.js'
import {chatsTable, usersTable} from '../lib/database/schema.js'
import type {Chat, NewChat} from '../lib/database/types.js'

export async function createOrUpdateChat(data: NewChat) {
  return db
    .insert(chatsTable)
    .values(data)
    .onConflictDoUpdate({
      target: chatsTable.id,
      set: data,
    })
    .returning()
    .then(res => {
      const row = res[0]
      if (row === undefined) throw new Error('Failed to create or update chat')
      return row
    })
}

export async function getChatOrThrow(id: Chat['id']) {
  const chat = await getChat({id})
  if (!chat) throw new Error('Chat not found')
  return chat
}

export async function getAccessibleChat(id: Chat['id']) {
  return db.query.chatsTable.findFirst({
    where: and(eq(chatsTable.id, id), ne(chatsTable.status, 'no_access')),
  })
}

export async function getChat(criteria: Partial<Chat>) {
  const where = Object.entries(criteria).map(([key, value]) => {
    const column = chatsTable[key as keyof Chat]
    if (value === null) return isNull(column)
    return eq(column, value)
  })
  return db
    .select()
    .from(chatsTable)
    .leftJoin(usersTable, eq(chatsTable.ownerId, usersTable.id))
    .where(and(...where))
    .then(res => {
      const row = res[0]
      if (!row) return null
      if (!row.users) throw new Error('Chat owner not found')
      return {
        ...row.chats,
        owner: row.users,
      }
    })
}

export async function updateChat(id: Chat['id'], criteria: Partial<Chat>) {
  return db
    .update(chatsTable)
    .set(criteria)
    .where(eq(chatsTable.id, id))
    .returning()
    .then(res => {
      const row = res[0]
      if (row === undefined) throw new Error('Chat not found after update')
      return row
    })
}

export function getPaginatedAccessibleChats(ownerId: Chat['ownerId'], page: number, limit: number) {
  const offset = (page - 1) * limit
  return db
    .select()
    .from(chatsTable)
    .where(and(eq(chatsTable.ownerId, ownerId), ne(chatsTable.status, 'no_access')))
    .offset(offset)
    .limit(limit)
    .orderBy(desc(chatsTable.createdAt))
}

export async function getAccessibleChatsCount(ownerId: Chat['ownerId']) {
  return db
    .select({count: count()})
    .from(chatsTable)
    .where(and(eq(chatsTable.ownerId, ownerId), ne(chatsTable.status, 'no_access')))
    .then(res => res[0]?.count ?? 0)
}
