import {randomUUID} from 'node:crypto'
import type {AppDatabase} from '@infra/db/client.js'
import {onchainChatPaymentsTable} from '@infra/db/schema.js'
import type {NewOnchainChatPayment, OnchainChatPayment} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, desc, eq, inArray, lt} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

export type OnchainPaymentStatus = OnchainChatPayment['status']

export function createOnchainPaymentRepository(database: AppDatabase) {
  return {
    async create(data: NewOnchainChatPayment): Promise<OnchainChatPayment> {
      return database
        .insert(onchainChatPaymentsTable)
        .values({...data, id: randomUUID()})
        .returning()
        .then(rows => firstOrThrow(rows, 'onchain_chat_payment'))
    },

    async findById(id: OnchainChatPayment['id']) {
      return database.query.onchainChatPaymentsTable.findFirst({
        where: eq(onchainChatPaymentsTable.id, id),
      })
    },

    async findByChargeId(satspayChargeId: string) {
      return database.query.onchainChatPaymentsTable.findFirst({
        where: eq(onchainChatPaymentsTable.satspayChargeId, satspayChargeId),
      })
    },

    async findOpenForUserChat(userId: number, chatId: number) {
      return database.query.onchainChatPaymentsTable.findFirst({
        where: and(
          eq(onchainChatPaymentsTable.userId, userId),
          eq(onchainChatPaymentsTable.chatId, chatId),
          inArray(onchainChatPaymentsTable.status, ['pending', 'grace']),
        ),
        orderBy: desc(onchainChatPaymentsTable.createdAt),
      })
    },

    /** Rows still open for webhook/cron (pending or grace). */
    async listWatchable(limit = 100) {
      return database.query.onchainChatPaymentsTable.findMany({
        where: inArray(onchainChatPaymentsTable.status, ['pending', 'grace']),
        limit,
        orderBy: desc(onchainChatPaymentsTable.createdAt),
      })
    },

    async markPaid(
      id: OnchainChatPayment['id'],
      args: {paidAt?: Date; txid?: string | null; subscriptionPaymentId?: string | null} = {},
    ): Promise<OnchainChatPayment | null> {
      const paidAt = args.paidAt ?? new Date()
      return database
        .update(onchainChatPaymentsTable)
        .set({
          status: 'paid',
          paidAt,
          ...(args.txid !== undefined ? {txid: args.txid} : {}),
          ...(args.subscriptionPaymentId !== undefined
            ? {subscriptionPaymentId: args.subscriptionPaymentId}
            : {}),
        })
        .where(
          and(
            eq(onchainChatPaymentsTable.id, id),
            inArray(onchainChatPaymentsTable.status, ['pending', 'grace']),
          ),
        )
        .returning()
        .then(rows => rows[0] ?? null)
    },

    async markGrace(id: OnchainChatPayment['id']): Promise<OnchainChatPayment | null> {
      return database
        .update(onchainChatPaymentsTable)
        .set({status: 'grace'})
        .where(
          and(eq(onchainChatPaymentsTable.id, id), eq(onchainChatPaymentsTable.status, 'pending')),
        )
        .returning()
        .then(rows => rows[0] ?? null)
    },

    async markExpired(id: OnchainChatPayment['id']): Promise<OnchainChatPayment | null> {
      return database
        .update(onchainChatPaymentsTable)
        .set({status: 'expired'})
        .where(
          and(
            eq(onchainChatPaymentsTable.id, id),
            inArray(onchainChatPaymentsTable.status, ['pending', 'grace']),
          ),
        )
        .returning()
        .then(rows => rows[0] ?? null)
    },

    async setTelegramMessage(
      id: OnchainChatPayment['id'],
      telegramChatId: number,
      telegramMessageId: number,
    ) {
      return database
        .update(onchainChatPaymentsTable)
        .set({telegramChatId, telegramMessageId})
        .where(eq(onchainChatPaymentsTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `onchain payment ${id}`))
    },

    async linkSubscriptionPayment(id: OnchainChatPayment['id'], subscriptionPaymentId: string) {
      return database
        .update(onchainChatPaymentsTable)
        .set({subscriptionPaymentId})
        .where(eq(onchainChatPaymentsTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `onchain payment ${id}`))
    },

    /** Pending rows whose UI TTL has passed (for message edit → grace). */
    async listPendingPastExpiresAt(now = new Date(), limit = 100) {
      return database.query.onchainChatPaymentsTable.findMany({
        where: and(
          eq(onchainChatPaymentsTable.status, 'pending'),
          lt(onchainChatPaymentsTable.expiresAt, now),
        ),
        limit,
      })
    },

    /** Grace/pending past watchUntil → expired. */
    async listPastWatchUntil(now = new Date(), limit = 100) {
      return database.query.onchainChatPaymentsTable.findMany({
        where: and(
          inArray(onchainChatPaymentsTable.status, ['pending', 'grace']),
          lt(onchainChatPaymentsTable.watchUntil, now),
        ),
        limit,
      })
    },
  }
}

export type OnchainPaymentRepository = ReturnType<typeof createOnchainPaymentRepository>

export const getOnchainPaymentByChargeId = (chargeId: string) =>
  getRuntime().onchainPayments.findByChargeId(chargeId)
