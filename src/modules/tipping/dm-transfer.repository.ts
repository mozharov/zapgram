import type {AppDatabase} from '@infra/db/client.js'
import {dmTransfersTable} from '@infra/db/schema.js'
import type {DmTransfer} from '@infra/db/types.js'
import {and, eq, isNull, lt, or} from 'drizzle-orm'

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
          ? isNull(dmTransfersTable.invoiceHash)
          : eq(dmTransfersTable.invoiceHash, expectedHash)
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
        .where(eq(dmTransfersTable.id, id))
    },

    async markSettled(id: string) {
      await database
        .update(dmTransfersTable)
        .set({status: 'settled', phase: 'settled'})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.status, 'pending')))
    },

    async markAbandoned(id: string) {
      await database
        .update(dmTransfersTable)
        .set({phase: 'abandoned', reviewLogged: true})
        .where(eq(dmTransfersTable.id, id))
    },

    async markNeedsReview(id: string): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({phase: 'needs_review', reviewLogged: true})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.reviewLogged, false)))
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

    async listActionable(limit: number, offset: number) {
      return database.query.dmTransfersTable.findMany({
        limit,
        offset,
        where: or(
          and(eq(dmTransfersTable.status, 'pending'), eq(dmTransfersTable.reviewLogged, false)),
          and(eq(dmTransfersTable.status, 'settled'), eq(dmTransfersTable.noticeSent, false)),
        ),
      })
    },
  }
}

export type DmTransferRepository = ReturnType<typeof createDmTransferRepository>
