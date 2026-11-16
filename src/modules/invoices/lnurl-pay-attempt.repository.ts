import type {AppDatabase} from '@infra/db/client.js'
import {lnurlPayAttemptsTable} from '@infra/db/schema.js'
import type {LnurlPayAttempt} from '@infra/db/types.js'
import {and, asc, eq, inArray, isNull, lte, ne, or} from 'drizzle-orm'

const OPEN_PHASES = ['pay_unknown', 'provider_accepted', 'needs_review'] as const

export function createLnurlPayAttemptRepository(database: AppDatabase) {
  async function get(id: string): Promise<LnurlPayAttempt> {
    const row = await database.query.lnurlPayAttemptsTable.findFirst({
      where: eq(lnurlPayAttemptsTable.id, id),
    })
    if (!row) throw new Error(`LNURL pay attempt ${id} not found`)
    return row
  }

  return {
    get,

    async reserve(input: {
      id: string
      fromUserId: number
      recipient: string
      sats: number
      rail: 'internal' | 'nwc'
      createdAt?: Date
    }) {
      await database
        .insert(lnurlPayAttemptsTable)
        .values({
          id: input.id,
          fromUserId: input.fromUserId,
          recipient: input.recipient,
          sats: input.sats,
          rail: input.rail,
          status: 'pending',
          phase: 'reserved',
          ...(input.createdAt ? {createdAt: input.createdAt} : {}),
        })
        .onConflictDoNothing()
      return get(input.id)
    },

    /** Another settled attempt already owns this invoice. */
    async findSettledByHash(hash: string, exceptId: string) {
      return database.query.lnurlPayAttemptsTable.findFirst({
        where: and(
          eq(lnurlPayAttemptsTable.invoiceHash, hash),
          eq(lnurlPayAttemptsTable.status, 'settled'),
          ne(lnurlPayAttemptsTable.id, exceptId),
        ),
      })
    },

    /** Another unresolved pay for this sender and recipient, if one exists. */
    async findOpen(fromUserId: number, recipient: string) {
      return database.query.lnurlPayAttemptsTable.findFirst({
        where: and(
          eq(lnurlPayAttemptsTable.fromUserId, fromUserId),
          eq(lnurlPayAttemptsTable.recipient, recipient),
          eq(lnurlPayAttemptsTable.status, 'pending'),
          inArray(lnurlPayAttemptsTable.phase, [...OPEN_PHASES]),
        ),
      })
    },

    /**
     * Persist the bolt11 that may be paid. A reserved row is the only one that
     * may gain its first hash. An abandoned row stays abandoned.
     */
    async saveInvoice(
      id: string,
      expectedHash: string | null,
      next: {hash: string; bolt11: string},
    ) {
      const expected =
        expectedHash === null
          ? and(
              isNull(lnurlPayAttemptsTable.invoiceHash),
              eq(lnurlPayAttemptsTable.phase, 'reserved'),
            )
          : and(
              eq(lnurlPayAttemptsTable.invoiceHash, expectedHash),
              eq(lnurlPayAttemptsTable.phase, 'invoice_saved'),
            )
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({invoiceHash: next.hash, bolt11: next.bolt11, phase: 'invoice_saved'})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            expected,
          ),
        )
        .returning()
      return row
    },

    async markPhase(
      id: string,
      phase: LnurlPayAttempt['phase'],
      expected: LnurlPayAttempt['phase'],
    ) {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({phase})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            eq(lnurlPayAttemptsTable.phase, expected),
          ),
        )
        .returning()
      return row
    },

    async markProviderAccepted(id: string, paymentHash: string | undefined) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({
          providerAccepted: true,
          phase: 'provider_accepted',
          ...(paymentHash ? {providerPaymentHash: paymentHash} : {}),
        })
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            ne(lnurlPayAttemptsTable.phase, 'abandoned'),
          ),
        )
    },

    /** True only when this call moved a pending row to settled. The loser of that race gets false. */
    async markSettled(id: string, senderNotified = false): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({
          status: 'settled',
          phase: 'settled',
          ...(senderNotified ? {senderNotified: true} : {}),
        })
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            ne(lnurlPayAttemptsTable.phase, 'abandoned'),
          ),
        )
        .returning()
      return row !== undefined
    },

    /**
     * Leave the row only while it is still in `expected`. A pay that started after
     * the read must not be marked abandoned, and must not be told it was cancelled.
     */
    async abandonIfPhase(
      id: string,
      expected: 'reserved' | 'invoice_saved' | 'pay_unknown' | 'needs_review',
      senderNotified = false,
    ): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({
          phase: 'abandoned',
          reviewLogged: true,
          ...(senderNotified ? {senderNotified: true} : {}),
        })
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            eq(lnurlPayAttemptsTable.phase, expected),
          ),
        )
        .returning()
      return row !== undefined
    },

    /**
     * Drop a pending row that lost the claim on its invoice, including one that
     * already flipped to provider_accepted. A settled row is left alone.
     */
    async dropUnclaimed(id: string, senderNotified = false) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({
          phase: 'abandoned',
          reviewLogged: true,
          ...(senderNotified ? {senderNotified: true} : {}),
        })
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            inArray(lnurlPayAttemptsTable.phase, [
              'reserved',
              'invoice_saved',
              'pay_unknown',
              'provider_accepted',
              'needs_review',
            ]),
          ),
        )
    },

    async markNeedsReview(id: string): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({phase: 'needs_review', reviewLogged: true})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            eq(lnurlPayAttemptsTable.phase, 'pay_unknown'),
            eq(lnurlPayAttemptsTable.reviewLogged, false),
          ),
        )
        .returning()
      return row !== undefined
    },

    async claimSenderNotice(id: string, review = false): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set(review ? {reviewNotified: true} : {senderNotified: true})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            ...(review
              ? [
                  eq(lnurlPayAttemptsTable.status, 'pending'),
                  eq(lnurlPayAttemptsTable.phase, 'needs_review'),
                ]
              : []),
            eq(
              review ? lnurlPayAttemptsTable.reviewNotified : lnurlPayAttemptsTable.senderNotified,
              false,
            ),
          ),
        )
        .returning()
      return row !== undefined
    },

    async releaseSenderNotice(id: string, review = false) {
      await database
        .update(lnurlPayAttemptsTable)
        .set(review ? {reviewNotified: false} : {senderNotified: false})
        .where(eq(lnurlPayAttemptsTable.id, id))
    },

    async deferReview(id: string, until: Date) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({reviewAfter: until})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            eq(lnurlPayAttemptsTable.phase, 'needs_review'),
          ),
        )
    },

    async listActionable(limit: number, offset: number, now = new Date()) {
      return database.query.lnurlPayAttemptsTable.findMany({
        limit,
        offset,
        // Unknown pays before sender notices, so a failed receipt cannot hide a debit.
        orderBy: [asc(lnurlPayAttemptsTable.status), asc(lnurlPayAttemptsTable.createdAt)],
        where: or(
          and(
            eq(lnurlPayAttemptsTable.status, 'pending'),
            or(
              inArray(lnurlPayAttemptsTable.phase, [
                'reserved',
                'invoice_saved',
                'pay_unknown',
                'provider_accepted',
              ]),
              and(
                eq(lnurlPayAttemptsTable.phase, 'abandoned'),
                eq(lnurlPayAttemptsTable.senderNotified, false),
              ),
              and(
                eq(lnurlPayAttemptsTable.phase, 'needs_review'),
                or(
                  eq(lnurlPayAttemptsTable.reviewNotified, false),
                  isNull(lnurlPayAttemptsTable.reviewAfter),
                  lte(lnurlPayAttemptsTable.reviewAfter, now),
                ),
              ),
            ),
          ),
          and(
            eq(lnurlPayAttemptsTable.status, 'settled'),
            eq(lnurlPayAttemptsTable.senderNotified, false),
          ),
        ),
      })
    },
  }
}

export type LnurlPayAttemptRepository = ReturnType<typeof createLnurlPayAttemptRepository>
