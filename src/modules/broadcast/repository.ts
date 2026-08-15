import {randomUUID} from 'node:crypto'
import type {AppLocale} from '@core/i18n/locale.js'
import type {AppDatabase} from '@infra/db/client.js'
import {broadcastRecipientsTable, broadcastsTable} from '@infra/db/schema.js'
import type {Broadcast, BroadcastRecipient} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, eq, inArray, isNotNull, lte, sql} from 'drizzle-orm'

export type BroadcastStatus = Broadcast['status']
export type RecipientStatus = BroadcastRecipient['status']

export function createBroadcastRepository(database: AppDatabase) {
  async function findById(id: string) {
    return database.query.broadcastsTable.findFirst({where: eq(broadcastsTable.id, id)})
  }

  return {
    findById,

    async createSending(input: {
      adminUserId: number
      locale: AppLocale
      sourceChatId: number
      sourceMessageId: number
      sourceReplyMarkup?: string | null
      recipientUserIds: readonly number[]
      now?: Date
    }): Promise<Broadcast> {
      const now = input.now ?? new Date()
      const id = randomUUID()
      const totalCount = input.recipientUserIds.length

      return database.transaction(tx => {
        const [broadcast] = tx
          .insert(broadcastsTable)
          .values({
            id,
            adminUserId: input.adminUserId,
            locale: input.locale,
            sourceChatId: input.sourceChatId,
            sourceMessageId: input.sourceMessageId,
            sourceReplyMarkup: input.sourceReplyMarkup ?? null,
            status: 'sending',
            totalCount,
            sentCount: 0,
            failedCount: 0,
            skippedCount: 0,
            createdAt: now,
            startedAt: now,
          })
          .returning()
          .all()

        if (!broadcast) throw new Error('Failed to insert broadcast')

        if (input.recipientUserIds.length > 0) {
          tx.insert(broadcastRecipientsTable)
            .values(
              input.recipientUserIds.map(userId => ({
                broadcastId: id,
                userId,
                status: 'pending' as const,
                updatedAt: now,
              })),
            )
            .run()
        }

        return broadcast
      })
    },

    async listSendingIds(): Promise<string[]> {
      const rows = await database
        .select({id: broadcastsTable.id})
        .from(broadcastsTable)
        .where(eq(broadcastsTable.status, 'sending'))
      return rows.map(r => r.id)
    },

    async listPendingRecipients(
      broadcastId: string,
      limit: number,
    ): Promise<Array<{userId: number}>> {
      return database
        .select({userId: broadcastRecipientsTable.userId})
        .from(broadcastRecipientsTable)
        .where(
          and(
            eq(broadcastRecipientsTable.broadcastId, broadcastId),
            eq(broadcastRecipientsTable.status, 'pending'),
          ),
        )
        .limit(limit)
    },

    async countPending(broadcastId: string): Promise<number> {
      const [row] = await database
        .select({count: sql<number>`count(*)`})
        .from(broadcastRecipientsTable)
        .where(
          and(
            eq(broadcastRecipientsTable.broadcastId, broadcastId),
            eq(broadcastRecipientsTable.status, 'pending'),
          ),
        )
      return Number(row?.count ?? 0)
    },

    /**
     * Mark one recipient terminal and bump aggregates. Idempotent if already non-pending.
     * Returns false when the row was already terminal (or missing).
     */
    async markRecipient(
      broadcastId: string,
      userId: number,
      status: Exclude<RecipientStatus, 'pending'>,
      error: string | null,
      now: Date = new Date(),
    ): Promise<boolean> {
      return database.transaction(tx => {
        const updated = tx
          .update(broadcastRecipientsTable)
          .set({status, error, updatedAt: now})
          .where(
            and(
              eq(broadcastRecipientsTable.broadcastId, broadcastId),
              eq(broadcastRecipientsTable.userId, userId),
              eq(broadcastRecipientsTable.status, 'pending'),
            ),
          )
          .returning({userId: broadcastRecipientsTable.userId})
          .all()

        if (updated.length === 0) return false

        const counter =
          status === 'sent' ? 'sentCount' : status === 'failed' ? 'failedCount' : 'skippedCount'

        tx.update(broadcastsTable)
          .set({
            [counter]: sql`${broadcastsTable[counter]} + 1`,
          })
          .where(eq(broadcastsTable.id, broadcastId))
          .run()

        return true
      })
    },

    async markCompleted(id: string, now: Date = new Date()) {
      return database
        .update(broadcastsTable)
        .set({status: 'completed', completedAt: now})
        .where(and(eq(broadcastsTable.id, id), eq(broadcastsTable.status, 'sending')))
        .returning()
        .then(rows => rows[0] ?? null)
    },

    async markReportSent(id: string, now: Date = new Date()) {
      return database
        .update(broadcastsTable)
        .set({reportSentAt: now})
        .where(eq(broadcastsTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `Broadcast ${id}`))
    },

    async deleteRecipients(broadcastId: string) {
      await database
        .delete(broadcastRecipientsTable)
        .where(eq(broadcastRecipientsTable.broadcastId, broadcastId))
    },

    async deleteCompletedOlderThan(cutoff: Date): Promise<number> {
      const deleted = await database
        .delete(broadcastsTable)
        .where(
          and(
            inArray(broadcastsTable.status, ['completed', 'cancelled', 'failed']),
            isNotNull(broadcastsTable.completedAt),
            lte(broadcastsTable.completedAt, cutoff),
          ),
        )
        .returning({id: broadcastsTable.id})
      return deleted.length
    },
  }
}

export type BroadcastRepository = ReturnType<typeof createBroadcastRepository>
