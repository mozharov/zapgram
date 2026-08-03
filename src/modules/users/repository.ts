import {AppError} from '@core/errors/app-error.js'
import type {AppDatabase} from '@infra/db/client.js'
import {usersTable} from '@infra/db/schema.js'
import type {NewUser, User} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {eq} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

export function createUserRepository(database: AppDatabase) {
  async function findById(id: User['id']) {
    return database.query.usersTable.findFirst({where: eq(usersTable.id, id)})
  }

  async function createOrUpdate(data: NewUser) {
    const values = {
      ...data,
      username: data.username?.toLowerCase(),
    }
    return database
      .insert(usersTable)
      .values(values)
      .onConflictDoUpdate({
        target: usersTable.id,
        set: values,
      })
      .returning()
      .then(rows => firstOrThrow(rows, 'user'))
  }

  return {
    findById,

    async findByUsername(username: string) {
      const user = await database.query.usersTable.findFirst({
        where: eq(usersTable.username, username.toLowerCase()),
      })
      return user as (User & {username: string}) | null | undefined
    },

    async getOrThrow(id: User['id']) {
      const user = await findById(id)
      if (!user) throw new AppError('not_found', {message: `User ${id} not found`})
      return user
    },

    /**
     * Returns the stored user, refreshing it when Telegram reports a changed profile.
     *
     * The refresh is load-bearing: `findByUsername` (used by `/tip @name`) reads the stored
     * username, so a stale row makes tips fail — or, once someone else takes the old handle,
     * routes sats to the wrong person.
     */
    async getOrCreate(data: NewUser) {
      const existing = await findById(data.id)
      if (!existing) return createOrUpdate(data)

      const username = data.username?.toLowerCase()
      const isCurrent =
        (username === undefined || existing.username === username) &&
        (data.firstName === undefined || existing.firstName === data.firstName) &&
        (data.languageCode === undefined || existing.languageCode === data.languageCode)

      return isCurrent ? existing : createOrUpdate(data)
    },

    createOrUpdate,

    async update(id: User['id'], data: Partial<User>) {
      const values = {
        ...data,
        ...(data.username !== undefined ? {username: data.username?.toLowerCase()} : {}),
      }
      return database
        .update(usersTable)
        .set(values)
        .where(eq(usersTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `User ${id}`))
    },
  }
}

export type UserRepository = ReturnType<typeof createUserRepository>

export const getOrCreateUser = (data: NewUser) => getRuntime().users.getOrCreate(data)
export const getUserOrThrow = (id: User['id']) => getRuntime().users.getOrThrow(id)
export const getUserByUsername = (username: string) => getRuntime().users.findByUsername(username)
export const createOrUpdateUser = (data: NewUser) => getRuntime().users.createOrUpdate(data)
export const updateUser = (id: User['id'], data: Partial<User>) =>
  getRuntime().users.update(id, data)
