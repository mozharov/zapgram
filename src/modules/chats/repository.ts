import {AppError} from '@core/errors/app-error.js'
import type {AppDatabase} from '@infra/db/client.js'
import {db as defaultDb} from '@infra/db/client.js'
import {chatsTable, usersTable} from '@infra/db/schema.js'
import type {Chat, NewChat} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, count, desc, eq, ne} from 'drizzle-orm'
import type {ChatWithOwner} from './types.js'

export function createChatRepository(database: AppDatabase) {
  async function findByIdWithOwner(id: Chat['id']): Promise<ChatWithOwner | null> {
    return database
      .select()
      .from(chatsTable)
      .leftJoin(usersTable, eq(chatsTable.ownerId, usersTable.id))
      .where(eq(chatsTable.id, id))
      .then(res => {
        const row = res[0]
        if (!row) return null
        if (!row.users) {
          throw new AppError('not_found', {message: `Chat ${id} owner not found`})
        }
        return {
          ...row.chats,
          owner: row.users,
        }
      })
  }

  return {
    async createOrUpdate(data: NewChat) {
      return database
        .insert(chatsTable)
        .values(data)
        .onConflictDoUpdate({
          target: chatsTable.id,
          set: data,
        })
        .returning()
        .then(rows => firstOrThrow(rows, 'chat'))
    },

    findByIdWithOwner,

    async findAccessibleById(id: Chat['id']) {
      return database.query.chatsTable.findFirst({
        where: and(eq(chatsTable.id, id), ne(chatsTable.status, 'no_access')),
      })
    },

    async getOrThrow(id: Chat['id']): Promise<ChatWithOwner> {
      const chat = await findByIdWithOwner(id)
      if (!chat) throw new AppError('not_found', {message: `Chat ${id} not found`})
      return chat
    },

    async update(id: Chat['id'], data: Partial<Chat>) {
      return database
        .update(chatsTable)
        .set(data)
        .where(eq(chatsTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `Chat ${id}`))
    },

    getPaginatedAccessible(ownerId: Chat['ownerId'], page: number, limit: number) {
      const offset = (page - 1) * limit
      return database
        .select()
        .from(chatsTable)
        .where(and(eq(chatsTable.ownerId, ownerId), ne(chatsTable.status, 'no_access')))
        .offset(offset)
        .limit(limit)
        .orderBy(desc(chatsTable.createdAt))
    },

    async getAccessibleCount(ownerId: Chat['ownerId']) {
      return database
        .select({count: count()})
        .from(chatsTable)
        .where(and(eq(chatsTable.ownerId, ownerId), ne(chatsTable.status, 'no_access')))
        .then(res => res[0]?.count ?? 0)
    },
  }
}

export type ChatRepository = ReturnType<typeof createChatRepository>

/** Legacy singleton — removed in step 11. */
export const chatsRepository = createChatRepository(defaultDb)

export const createOrUpdateChat = (data: NewChat) => chatsRepository.createOrUpdate(data)
export const getChatOrThrow = (id: Chat['id']) => chatsRepository.getOrThrow(id)
export const getAccessibleChat = (id: Chat['id']) => chatsRepository.findAccessibleById(id)
/** @deprecated Prefer findByIdWithOwner(id). Accepts {id} for call-site compatibility. */
export const getChat = (criteria: {id: Chat['id']}) =>
  chatsRepository.findByIdWithOwner(criteria.id)
export const updateChat = (id: Chat['id'], data: Partial<Chat>) => chatsRepository.update(id, data)
export const getPaginatedAccessibleChats = (
  ownerId: Chat['ownerId'],
  page: number,
  limit: number,
) => chatsRepository.getPaginatedAccessible(ownerId, page, limit)
export const getAccessibleChatsCount = (ownerId: Chat['ownerId']) =>
  chatsRepository.getAccessibleCount(ownerId)
