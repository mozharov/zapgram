import {and, eq} from 'drizzle-orm'
import {db} from '../lib/database/database.js'
import {usersTable} from '../lib/database/schema.js'
import type {NewUser, User} from '../lib/database/types.js'

export async function getOrCreateUser(data: NewUser) {
  return (await getUserBy(data)) ?? (await createOrUpdateUser(data))
}

export async function getUserOrThrow(id: User['id']) {
  const user = await getUserBy({id})
  if (!user) throw new Error('User not found')
  return user
}

export async function getUserByUsername(username: string) {
  const user = await getUserBy({username})
  return user as (User & {username: string}) | null
}

export async function getUserBy(criteria: Partial<User>) {
  if (criteria.username) criteria.username = criteria.username.toLowerCase()
  const where = Object.entries(criteria)
    .filter((entry): entry is [string, NonNullable<User[keyof User]>] => entry[1] != null)
    .map(([key, value]) => eq(usersTable[key as keyof User], value))
  return db.query.usersTable.findFirst({where: and(...where)})
}

export async function createOrUpdateUser(data: NewUser) {
  if (data.username) data.username = data.username.toLowerCase()
  return db
    .insert(usersTable)
    .values(data)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: data,
    })
    .returning()
    .then(res => {
      const row = res[0]
      if (row === undefined) throw new Error('Failed to create or update user')
      return row
    })
}

export async function updateUser(id: User['id'], data: Partial<User>) {
  if (data.username) data.username = data.username.toLowerCase()
  return db
    .update(usersTable)
    .set(data)
    .where(eq(usersTable.id, id))
    .returning()
    .then(res => {
      const row = res[0]
      if (row === undefined) throw new Error('User not found after update')
      return row
    })
}
