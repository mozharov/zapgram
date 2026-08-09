import {type DonationLedgerKind, MONTHLY_DONATION_PERIOD_MS} from '@core/money/donation.js'
import type {AppDatabase} from '@infra/db/client.js'
import {donationPlatformStatsTable, donationsTable} from '@infra/db/schema.js'
import type {Donation, NewDonation} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {desc, eq, gte, sql} from 'drizzle-orm'
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
    const id = data.id ?? crypto.randomUUID()
    const amountSats = data.amountSats

    return database.transaction(async tx => {
      const row = await tx
        .insert(donationsTable)
        .values({...data, id})
        .returning()
        .then(rows => firstOrThrow(rows, 'donation'))

      // Keep singleton totals in lockstep with the ledger (O(1) /donate all-time read).
      await tx
        .insert(donationPlatformStatsTable)
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

      return row
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
