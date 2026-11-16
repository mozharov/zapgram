import type {AppDatabase} from '@infra/db/client.js'
import {dmTransfersTable} from '@infra/db/schema.js'
import type {DmTransfer} from '@infra/db/types.js'
import {and, asc, eq, inArray, isNull, lt, lte, ne, or} from 'drizzle-orm'

const OPEN_PHASES = ['pay_unknown', 'provider_accepted', 'needs_review'] as const

export type DmTransferInvoice = {hash: string; bolt11: string}

export function createDmTransferRepository(database: AppDatabase) {
  async function get(id: string): Promise<DmTransfer> {
    const row = await database.query.dmTransfersTable.findFirst({
      where: eq(dmTransfersTable.id, id),
    })
    if (!row) throw new Error(`DM transfer ${id} not found`)
    return row
  }

  return {
    get,

    /** Insert the pending row, or return the row another worker already inserted. */
    async reserve(input: {
      id: string
      fromUserId: number
      toUserId: number
      sats: number
      rail: 'internal' | 'nwc'
      createdAt?: Date
    }) {
      await database
        .insert(dmTransfersTable)
        .values({
          id: input.id,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          sats: input.sats,
          rail: input.rail,
          status: 'pending',
          phase: 'reserved',
          ...(input.createdAt ? {createdAt: input.createdAt} : {}),
        })
        .onConflictDoNothing()
      return get(input.id)
    },

    /**
     * Persist the invoice that may be paid. Only one caller wins for a given expected hash
     * (`null` when the row has none yet). The loser must pay neither invoice.
     */
    async saveInvoice(id: string, expectedHash: string | null, next: DmTransferInvoice) {
      const expected =
        expectedHash === null
          ? and(isNull(dmTransfersTable.invoiceHash), eq(dmTransfersTable.phase, 'reserved'))
          : and(
              eq(dmTransfersTable.invoiceHash, expectedHash),
              eq(dmTransfersTable.phase, 'invoice_saved'),
            )
      const [row] = await database
        .update(dmTransfersTable)
        .set({invoiceHash: next.hash, bolt11: next.bolt11, phase: 'invoice_saved'})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.status, 'pending'), expected))
        .returning()
      return row
    },

    async saveFeeInvoice(id: string, next: DmTransferInvoice) {
      const [row] = await database
        .update(dmTransfersTable)
        .set({feeHash: next.hash, feeBolt11: next.bolt11})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'settled'),
            isNull(dmTransfersTable.feeHash),
          ),
        )
        .returning()
      return row
    },

    async markPhase(
      id: string,
      phase: DmTransfer['phase'],
      expected: DmTransfer['phase'],
    ): Promise<DmTransfer | undefined> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({phase})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            eq(dmTransfersTable.phase, expected),
          ),
        )
        .returning()
      return row
    },

    async markProviderAccepted(id: string, paymentHash: string | undefined) {
      await database
        .update(dmTransfersTable)
        .set({
          providerAccepted: true,
          phase: 'provider_accepted',
          ...(paymentHash ? {providerPaymentHash: paymentHash} : {}),
        })
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            inArray(dmTransfersTable.phase, ['pay_unknown', 'needs_review', 'provider_accepted']),
          ),
        )
    },

    /** True only when this call moved a pending row to settled. */
    async markSettled(id: string, senderNotified = false): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({
          status: 'settled',
          phase: 'settled',
          ...(senderNotified ? {senderNotified: true} : {}),
        })
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            ne(dmTransfersTable.phase, 'abandoned'),
          ),
        )
        .returning()
      return row !== undefined
    },

    /** Another unresolved pay from this sender to this recipient, if one exists. */
    async findOpen(fromUserId: number, toUserId: number) {
      return database.query.dmTransfersTable.findFirst({
        where: and(
          eq(dmTransfersTable.fromUserId, fromUserId),
          eq(dmTransfersTable.toUserId, toUserId),
          eq(dmTransfersTable.status, 'pending'),
          inArray(dmTransfersTable.phase, [...OPEN_PHASES]),
        ),
      })
    },

    async abandonIfPhase(
      id: string,
      expected: 'reserved' | 'invoice_saved' | 'pay_unknown' | 'needs_review',
      senderNotified = false,
    ): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({
          phase: 'abandoned',
          reviewLogged: true,
          ...(senderNotified ? {senderNotified: true} : {}),
        })
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            eq(dmTransfersTable.phase, expected),
          ),
        )
        .returning()
      return row !== undefined
    },

    async markNeedsReview(id: string): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({phase: 'needs_review', reviewLogged: true})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            eq(dmTransfersTable.phase, 'pay_unknown'),
            eq(dmTransfersTable.reviewLogged, false),
          ),
        )
        .returning()
      return row !== undefined
    },

    async markFeeSkipped(id: string) {
      await database
        .update(dmTransfersTable)
        .set({feeSkipped: true})
        .where(eq(dmTransfersTable.id, id))
    },

    /**
     * One worker may send. The claim is not delivery: `noticeSent` flips only after
     * Telegram accepts the message. A second worker loses this update.
     */
    async claimNotice(id: string, now: Date, leaseMs: number): Promise<boolean> {
      const expiresAt = new Date(now.getTime() + leaseMs)
      const [row] = await database
        .update(dmTransfersTable)
        .set({noticeClaimed: true, noticeClaimExpiresAt: expiresAt})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.noticeSent, false),
            or(
              eq(dmTransfersTable.noticeClaimed, false),
              isNull(dmTransfersTable.noticeClaimExpiresAt),
              lt(dmTransfersTable.noticeClaimExpiresAt, now),
            ),
          ),
        )
        .returning()
      return row !== undefined
    },

    async markNoticeSent(id: string) {
      await database
        .update(dmTransfersTable)
        .set({noticeSent: true})
        .where(eq(dmTransfersTable.id, id))
    },

    /** The send did not land. Clear the claim so a later settle can try once more. */
    async releaseNotice(id: string) {
      await database
        .update(dmTransfersTable)
        .set({noticeClaimed: false, noticeClaimExpiresAt: null})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.noticeSent, false)))
    },

    /**
     * Count a failed notice. `drop` stops further retries: a 403, or the attempt cap.
     * The claim is released either way so a non-dropped row can be taken again.
     */
    async recordNoticeFailure(id: string, drop: boolean) {
      const row = await get(id)
      await database
        .update(dmTransfersTable)
        .set({
          noticeAttempts: row.noticeAttempts + 1,
          noticeDropped: drop,
          noticeClaimed: false,
          noticeClaimExpiresAt: null,
        })
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.noticeSent, false)))
    },

    async claimSenderNotice(id: string, review = false): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set(review ? {reviewNotified: true} : {senderNotified: true})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            ...(review
              ? [eq(dmTransfersTable.status, 'pending'), eq(dmTransfersTable.phase, 'needs_review')]
              : []),
            eq(review ? dmTransfersTable.reviewNotified : dmTransfersTable.senderNotified, false),
          ),
        )
        .returning()
      return row !== undefined
    },

    async releaseSenderNotice(id: string, review = false) {
      await database
        .update(dmTransfersTable)
        .set(review ? {reviewNotified: false} : {senderNotified: false})
        .where(eq(dmTransfersTable.id, id))
    },

    async deferReview(id: string, until: Date) {
      await database
        .update(dmTransfersTable)
        .set({reviewAfter: until})
        .where(
          and(
            eq(dmTransfersTable.id, id),
            eq(dmTransfersTable.status, 'pending'),
            eq(dmTransfersTable.phase, 'needs_review'),
          ),
        )
    },

    async listActionable(limit: number, offset: number, now = new Date()) {
      return database.query.dmTransfersTable.findMany({
        limit,
        offset,
        // Pending pays come before notices. A page of blocked-recipient retries
        // must not hide a payment whose outcome is still unknown.
        orderBy: [asc(dmTransfersTable.status), asc(dmTransfersTable.createdAt)],
        where: or(
          and(
            eq(dmTransfersTable.status, 'pending'),
            or(
              inArray(dmTransfersTable.phase, [
                'reserved',
                'invoice_saved',
                'pay_unknown',
                'provider_accepted',
              ]),
              and(
                eq(dmTransfersTable.phase, 'abandoned'),
                eq(dmTransfersTable.senderNotified, false),
              ),
              and(
                eq(dmTransfersTable.phase, 'needs_review'),
                or(
                  eq(dmTransfersTable.reviewNotified, false),
                  isNull(dmTransfersTable.reviewAfter),
                  lte(dmTransfersTable.reviewAfter, now),
                ),
              ),
            ),
          ),
          and(
            eq(dmTransfersTable.status, 'settled'),
            eq(dmTransfersTable.noticeSent, false),
            eq(dmTransfersTable.noticeDropped, false),
          ),
          and(eq(dmTransfersTable.status, 'settled'), eq(dmTransfersTable.senderNotified, false)),
        ),
      })
    },
  }
}

export type DmTransferRepository = ReturnType<typeof createDmTransferRepository>
