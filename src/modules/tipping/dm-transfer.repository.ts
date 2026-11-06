import type {AppDatabase} from '@infra/db/client.js'
import {dmTransfersTable} from '@infra/db/schema.js'
import type {DmTransfer} from '@infra/db/types.js'
import {and, eq, isNull} from 'drizzle-orm'

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
    async reserve(input: {id: string; fromUserId: number; toUserId: number; sats: number}) {
      await database
        .insert(dmTransfersTable)
        .values({...input, status: 'pending'})
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
        .set({invoiceHash: next.hash, bolt11: next.bolt11})
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

    async markSettled(id: string) {
      await database
        .update(dmTransfersTable)
        .set({status: 'settled'})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.status, 'pending')))
    },

    /**
     * Claim the recipient notice. Only the caller that flips `noticeSent` from false
     * may send. A second worker sees the flag already set and must not send again.
     */
    async claimNotice(id: string): Promise<boolean> {
      const [row] = await database
        .update(dmTransfersTable)
        .set({noticeSent: true})
        .where(and(eq(dmTransfersTable.id, id), eq(dmTransfersTable.noticeSent, false)))
        .returning()
      return row !== undefined
    },

    /** The send did not land. Clear the claim so a later settle can try once more. */
    async releaseNotice(id: string) {
      await database
        .update(dmTransfersTable)
        .set({noticeSent: false})
        .where(eq(dmTransfersTable.id, id))
    },
  }
}

export type DmTransferRepository = ReturnType<typeof createDmTransferRepository>
