import {randomUUID} from 'node:crypto'
import type {AppDatabase} from '@infra/db/client.js'
import {db as defaultDb} from '@infra/db/client.js'
import {chatsTable, subscriptionsTable} from '@infra/db/schema.js'
import type {NewSubscription, Subscription} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, count, desc, eq, gt, lte} from 'drizzle-orm'
import type {SubscriptionWithChat} from './types.js'

export function createSubscriptionRepository(database: AppDatabase) {
  return {
    async create(data: NewSubscription) {
      return database
        .insert(subscriptionsTable)
        .values({...data, id: randomUUID()})
        .returning()
        .then(rows => firstOrThrow(rows, 'subscription'))
    },

    async findByUserAndChat(userId: Subscription['userId'], chatId: Subscription['chatId']) {
      return database.query.subscriptionsTable.findFirst({
        where: and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.chatId, chatId)),
      })
    },

    async update(id: Subscription['id'], data: Partial<Subscription>) {
      return database
        .update(subscriptionsTable)
        .set(data)
        .where(eq(subscriptionsTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `Subscription ${id}`))
    },

    async getExpired(limit?: number, offset?: number, date?: Date) {
      return database.query.subscriptionsTable.findMany({
        where: lte(subscriptionsTable.endsAt, date ?? new Date()),
        orderBy: desc(subscriptionsTable.id),
        limit,
        offset,
      })
    },

    /**
     * Deletes only if endsAt is still <= the given time (race guard against a concurrent renewal).
     */
    async delete(id: Subscription['id'], endsAt?: Date) {
      await database
        .delete(subscriptionsTable)
        .where(
          and(eq(subscriptionsTable.id, id), lte(subscriptionsTable.endsAt, endsAt ?? new Date())),
        )
    },

    async countExpired(date?: Date) {
      return database
        .select({count: count()})
        .from(subscriptionsTable)
        .where(lte(subscriptionsTable.endsAt, date ?? new Date()))
        .then(rows => rows[0]?.count ?? 0)
    },

    async getExpiringWithin(
      maxExpiryDate: Date,
      minExpiryDate: Date,
      limit: number,
      offset: number,
    ): Promise<Subscription[]> {
      return database.query.subscriptionsTable.findMany({
        where: and(
          lte(subscriptionsTable.endsAt, maxExpiryDate),
          gt(subscriptionsTable.endsAt, minExpiryDate),
          eq(subscriptionsTable.notificationSent, false),
        ),
        limit,
        offset,
      })
    },

    async countExpiringWithin(maxExpiryDate: Date, minExpiryDate: Date) {
      return database
        .select({count: count()})
        .from(subscriptionsTable)
        .where(
          and(
            lte(subscriptionsTable.endsAt, maxExpiryDate),
            gt(subscriptionsTable.endsAt, minExpiryDate),
            eq(subscriptionsTable.notificationSent, false),
          ),
        )
        .then(rows => rows[0]?.count ?? 0)
    },

    async getUserActive(
      userId: Subscription['userId'],
      page: number,
      limit: number,
    ): Promise<SubscriptionWithChat[]> {
      const offset = (page - 1) * limit
      return database
        .select()
        .from(subscriptionsTable)
        .leftJoin(chatsTable, eq(subscriptionsTable.chatId, chatsTable.id))
        .where(eq(subscriptionsTable.userId, userId))
        .offset(offset)
        .limit(limit)
        .orderBy(desc(subscriptionsTable.createdAt))
        .then(rows =>
          rows.map(row => {
            if (!row.chats) throw firstOrThrow([], `Subscription ${row.subscriptions.id} chat`)
            return {
              ...row.subscriptions,
              chat: row.chats,
            }
          }),
        )
    },

    async getUserActiveCount(userId: Subscription['userId']) {
      return database
        .select({count: count()})
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.userId, userId))
        .then(rows => rows[0]?.count ?? 0)
    },

    async findByIdWithChat(id: Subscription['id']): Promise<SubscriptionWithChat | null> {
      return database
        .select()
        .from(subscriptionsTable)
        .leftJoin(chatsTable, eq(subscriptionsTable.chatId, chatsTable.id))
        .where(eq(subscriptionsTable.id, id))
        .then(rows => {
          const row = rows[0]
          if (!row) return null
          if (!row.chats) throw firstOrThrow([], `Subscription ${id} chat`)
          return {
            ...row.subscriptions,
            chat: row.chats,
          }
        })
    },
  }
}

export type SubscriptionRepository = ReturnType<typeof createSubscriptionRepository>

/** Legacy singleton — removed in step 11. */
export const subscriptionsRepository = createSubscriptionRepository(defaultDb)

export const createSubscription = (data: NewSubscription) => subscriptionsRepository.create(data)
export const getSubscriptionByUserAndChat = (
  userId: Subscription['userId'],
  chatId: Subscription['chatId'],
) => subscriptionsRepository.findByUserAndChat(userId, chatId)
export const updateSubscription = (id: Subscription['id'], data: Partial<Subscription>) =>
  subscriptionsRepository.update(id, data)
export const getExpiredSubscriptions = (limit?: number, offset?: number, date?: Date) =>
  subscriptionsRepository.getExpired(limit, offset, date)
export const deleteSubscription = (id: Subscription['id'], endsAt?: Date) =>
  subscriptionsRepository.delete(id, endsAt)
export const countExpiredSubscriptions = (date?: Date) => subscriptionsRepository.countExpired(date)
export const getSubscriptionsExpiringWithin = (
  maxExpiryDate: Date,
  minExpiryDate: Date,
  limit: number,
  offset: number,
) => subscriptionsRepository.getExpiringWithin(maxExpiryDate, minExpiryDate, limit, offset)
export const countSubscriptionsExpiringWithin = (maxExpiryDate: Date, minExpiryDate: Date) =>
  subscriptionsRepository.countExpiringWithin(maxExpiryDate, minExpiryDate)
export const getUserActiveSubscriptions = (
  userId: Subscription['userId'],
  page: number,
  limit: number,
) => subscriptionsRepository.getUserActive(userId, page, limit)
export const getUserActiveSubscriptionsCount = (userId: Subscription['userId']) =>
  subscriptionsRepository.getUserActiveCount(userId)
export const getSubscriptionById = (id: Subscription['id']) =>
  subscriptionsRepository.findByIdWithChat(id)
