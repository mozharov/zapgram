import type {AppDatabase} from '@infra/db/client.js'
import {lnurlPayAttemptsTable} from '@infra/db/schema.js'
import type {LnurlPayAttempt} from '@infra/db/types.js'
import {and, asc, eq, inArray, isNull, ne, or} from 'drizzle-orm'

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

    async markSettled(id: string) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({status: 'settled', phase: 'settled'})
        .where(and(eq(lnurlPayAttemptsTable.id, id), eq(lnurlPayAttemptsTable.status, 'pending')))
    },

    async markAbandoned(id: string) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({phase: 'abandoned', reviewLogged: true})
        .where(
          and(
            eq(lnurlPayAttemptsTable.id, id),
            eq(lnurlPayAttemptsTable.status, 'pending'),
            or(
              eq(lnurlPayAttemptsTable.phase, 'reserved'),
              eq(lnurlPayAttemptsTable.phase, 'invoice_saved'),
              eq(lnurlPayAttemptsTable.phase, 'pay_unknown'),
            ),
          ),
        )
    },

    async markNeedsReview(id: string): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({phase: 'needs_review', reviewLogged: true})
        .where(and(eq(lnurlPayAttemptsTable.id, id), eq(lnurlPayAttemptsTable.reviewLogged, false)))
        .returning()
      return row !== undefined
    },

    async claimSenderNotice(id: string): Promise<boolean> {
      const [row] = await database
        .update(lnurlPayAttemptsTable)
        .set({senderNotified: true})
        .where(
          and(eq(lnurlPayAttemptsTable.id, id), eq(lnurlPayAttemptsTable.senderNotified, false)),
        )
        .returning()
      return row !== undefined
    },

    async releaseSenderNotice(id: string) {
      await database
        .update(lnurlPayAttemptsTable)
        .set({senderNotified: false})
        .where(eq(lnurlPayAttemptsTable.id, id))
    },

    async listActionable(limit: number, offset: number) {
      return database.query.lnurlPayAttemptsTable.findMany({
        limit,
        offset,
        orderBy: [asc(lnurlPayAttemptsTable.createdAt)],
        where: and(
          eq(lnurlPayAttemptsTable.status, 'pending'),
          eq(lnurlPayAttemptsTable.reviewLogged, false),
        ),
      })
    },
  }
}

export type LnurlPayAttemptRepository = ReturnType<typeof createLnurlPayAttemptRepository>
