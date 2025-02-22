import {db} from '../lib/database/database.js'
import {chatsTable, usersTable} from '../lib/database/schema.js'
import type {NewChat, Chat} from '../lib/database/types.js'
import {and, eq} from 'drizzle-orm'

export async function getOrCreateChat(data: NewChat) {
  return (await getChat(data)) ?? (await createOrUpdateChat(data))
}

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

export async function getChat(criteria: Partial<Chat>) {
  const where = Object.entries(criteria).map(([key, value]) =>
    eq(chatsTable[key as keyof Chat], value!),
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

export async function deleteChat(criteria: Partial<Chat>) {
  const where = Object.entries(criteria).map(([key, value]) =>
    eq(chatsTable[key as keyof Chat], value!),
  )
  await db.delete(chatsTable).where(and(...where))
}

export async function updateChat(id: Chat['id'], criteria: Partial<Chat>) {
  await db.update(chatsTable).set(criteria).where(eq(chatsTable.id, id))
}
