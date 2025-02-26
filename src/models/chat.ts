import {db} from '../lib/database/database.js'
import {chatsTable, usersTable} from '../lib/database/schema.js'
import type {NewChat, Chat} from '../lib/database/types.js'
import {and, count, eq, ne, desc} from 'drizzle-orm'

export async function createOrUpdateChat(data: NewChat) {
  return db
    .insert(chatsTable)
    .values(data)
    .onConflictDoUpdate({
      target: chatsTable.id,
      set: data,
    })
    .returning()
    .then(res => res[0]!)
}

export async function getAccessibleChat(id: Chat['id']) {
  return db.query.chatsTable.findFirst({
    where: and(eq(chatsTable.id, id), ne(chatsTable.status, 'no_access')),
  })
}

export async function getChat(criteria: Partial<Chat>) {
  const where = Object.entries(criteria).map(([key, value]) =>
    eq(chatsTable[key as keyof Chat], value),
  )
  return db
    .select()
    .from(chatsTable)
    .leftJoin(usersTable, eq(chatsTable.ownerId, usersTable.id))
    .where(and(...where))
    .then(res => {
      if (!res[0]) return null
      return {
        ...res[0].chats,
        owner: res[0].users!,
      }
    })
}

export async function updateChat(id: Chat['id'], criteria: Partial<Chat>) {
  return db
    .update(chatsTable)
    .set(criteria)
    .where(eq(chatsTable.id, id))
    .returning()
    .then(res => res[0]!)
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
    .then(res => res[0]!.count)
}
