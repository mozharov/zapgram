import {AppError} from '@core/errors/app-error.js'
import type {AppDatabase} from '@infra/db/client.js'
import {db as defaultDb} from '@infra/db/client.js'
import {usersTable} from '@infra/db/schema.js'
import type {NewUser, User} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {eq} from 'drizzle-orm'

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

    async getOrCreate(data: NewUser) {
      return (await findById(data.id)) ?? (await createOrUpdate(data))
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

/** Legacy singleton — removed in step 11. */
export const usersRepository = createUserRepository(defaultDb)

// Legacy function names used by existing call sites.
export const getOrCreateUser = (data: NewUser) => usersRepository.getOrCreate(data)
export const getUserOrThrow = (id: User['id']) => usersRepository.getOrThrow(id)
export const getUserByUsername = (username: string) => usersRepository.findByUsername(username)
export const createOrUpdateUser = (data: NewUser) => usersRepository.createOrUpdate(data)
export const updateUser = (id: User['id'], data: Partial<User>) => usersRepository.update(id, data)
