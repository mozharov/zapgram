import {type DonationLedgerKind, MONTHLY_DONATION_PERIOD_MS} from '@core/money/donation.js'
import type {AppDatabase} from '@infra/db/client.js'
import {
  donationPlatformStatsTable,
  donationsTable,
  pendingDonationPaymentsTable,
} from '@infra/db/schema.js'
import type {Donation, NewDonation, PendingDonationPayment} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, asc, desc, eq, gte, sql} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

export type UserDonationStats = {
  totalSats: number
  count: number
  lastAt: Date | null
}

/** Global totals shown on /donate (all users). */
export type PlatformDonationStats = {
  /** All-time successful donations (from singleton counter). */
  totalSats: number
  totalCount: number
  /** Rolling last 30 days (SUM over ledger with created_at index). */
  lastMonthSats: number
  lastMonthCount: number
}

const PLATFORM_STATS_ID = 1

export function createDonationRepository(database: AppDatabase) {
  async function ensurePlatformStatsRow(): Promise<void> {
    await database
      .insert(donationPlatformStatsTable)
      .values({id: PLATFORM_STATS_ID, totalSats: 0, totalCount: 0})
      .onConflictDoNothing()
  }

  async function insert(data: NewDonation & {id?: string}): Promise<Donation> {
    // bun-sqlite commits when this callback returns. Awaiting inside it runs the second write
    // after the commit, so a failed total update would leave the ledger row behind.
    return database.transaction(tx => insertRow(tx, data))
  }

  function insertRow(tx: Pick<AppDatabase, 'insert'>, data: NewDonation & {id?: string}): Donation {
    const amountSats = data.amountSats
    const row = firstOrThrow(
      tx
        .insert(donationsTable)
        .values({...data, id: data.id ?? crypto.randomUUID()})
        .returning()
        .all(),
      'donation',
    )

    // Keep singleton totals in lockstep with the ledger (O(1) /donate all-time read).
    tx.insert(donationPlatformStatsTable)
      .values({
        id: PLATFORM_STATS_ID,
        totalSats: amountSats,
        totalCount: 1,
      })
      .onConflictDoUpdate({
        target: donationPlatformStatsTable.id,
        set: {
          totalSats: sql`${donationPlatformStatsTable.totalSats} + ${amountSats}`,
          totalCount: sql`${donationPlatformStatsTable.totalCount} + 1`,
          updatedAt: new Date(),
        },
      })
      .run()

    return row
  }

  async function savePending(data: Omit<PendingDonationPayment, 'createdAt'>) {
    await database.insert(pendingDonationPaymentsTable).values(data).onConflictDoNothing()
  }

  async function listPending(userId?: number, kind?: PendingDonationPayment['kind']) {
    return database
      .select()
      .from(pendingDonationPaymentsTable)
      .where(
        and(
          userId === undefined ? undefined : eq(pendingDonationPaymentsTable.userId, userId),
          kind === undefined ? undefined : eq(pendingDonationPaymentsTable.kind, kind),
        ),
      )
      .orderBy(
        asc(pendingDonationPaymentsTable.createdAt),
        asc(pendingDonationPaymentsTable.paymentHash),
      )
  }

  async function removePending(hash: string) {
    await database
      .delete(pendingDonationPaymentsTable)
      .where(eq(pendingDonationPaymentsTable.paymentHash, hash))
  }

  /** Ledger, totals and pending removal commit together; UI and cron may reconcile concurrently. */
  async function completePending(hash: string) {
    return database.transaction(tx => {
      const pending = tx
        .select()
        .from(pendingDonationPaymentsTable)
        .where(eq(pendingDonationPaymentsTable.paymentHash, hash))
        .get()
      if (!pending) return
      const existing = tx
        .select()
        .from(donationsTable)
        .where(eq(donationsTable.paymentHash, hash))
        .get()
      if (!existing)
        insertRow(tx, {
          userId: pending.userId,
          amountSats: pending.amountSats,
          kind: pending.kind === 'percent' ? 'percent' : 'one_shot',
          paymentHash: hash,
        })
      tx.delete(pendingDonationPaymentsTable)
        .where(eq(pendingDonationPaymentsTable.paymentHash, hash))
        .run()
    })
  }

  async function getUserStats(userId: number): Promise<UserDonationStats> {
    const [agg] = await database
      .select({
        totalSats: sql<number>`coalesce(sum(${donationsTable.amountSats}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(donationsTable)
      .where(eq(donationsTable.userId, userId))

    const last = await database.query.donationsTable.findFirst({
      where: eq(donationsTable.userId, userId),
      orderBy: [desc(donationsTable.createdAt)],
    })

    return {
      totalSats: Number(agg?.totalSats ?? 0),
      count: Number(agg?.count ?? 0),
      lastAt: last?.createdAt ?? null,
    }
  }

  async function getPlatformStats(now: Date = new Date()): Promise<PlatformDonationStats> {
    await ensurePlatformStatsRow()

    const row = await database.query.donationPlatformStatsTable.findFirst({
      where: eq(donationPlatformStatsTable.id, PLATFORM_STATS_ID),
    })

    const since = new Date(now.getTime() - MONTHLY_DONATION_PERIOD_MS)
    const [month] = await database
      .select({
        totalSats: sql<number>`coalesce(sum(${donationsTable.amountSats}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(donationsTable)
      .where(gte(donationsTable.createdAt, since))

    return {
      totalSats: Number(row?.totalSats ?? 0),
      totalCount: Number(row?.totalCount ?? 0),
      lastMonthSats: Number(month?.totalSats ?? 0),
      lastMonthCount: Number(month?.count ?? 0),
    }
  }

  async function findByPaymentHash(paymentHash: string) {
    return database.query.donationsTable.findFirst({
      where: eq(donationsTable.paymentHash, paymentHash),
    })
  }

  return {
    insert,
    savePending,
    listPending,
    removePending,
    completePending,
    getUserStats,
    getPlatformStats,
    findByPaymentHash,
    async insertDonation(input: {
      userId: number
      amountSats: number
      kind: DonationLedgerKind
      paymentHash?: string | null
    }) {
      return insert({
        userId: input.userId,
        amountSats: input.amountSats,
        kind: input.kind,
        paymentHash: input.paymentHash ?? null,
      })
    },
  }
}

export type DonationRepository = ReturnType<typeof createDonationRepository>

export const insertDonation = (input: Parameters<DonationRepository['insertDonation']>[0]) =>
  getRuntime().donations.insertDonation(input)

export const getUserDonationStats = (userId: number) => getRuntime().donations.getUserStats(userId)
