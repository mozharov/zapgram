import {type DonationLedgerKind, MONTHLY_DONATION_PERIOD_MS} from '@core/money/donation.js'
import type {AppDatabase} from '@infra/db/client.js'
import {
  donationPaymentSlotsTable,
  donationPlatformStatsTable,
  donationsTable,
  pendingDonationPaymentsTable,
} from '@infra/db/schema.js'
import type {
  Donation,
  NewDonation,
  NewPendingDonationPayment,
  PendingDonationPayment,
} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, asc, desc, eq, gt, gte, lte, sql} from 'drizzle-orm'
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

  async function savePending(data: NewPendingDonationPayment) {
    await database.insert(pendingDonationPaymentsTable).values(data).onConflictDoNothing()
  }

  function pendingScope(userId: number, kind: PendingDonationPayment['kind'], attemptId?: string) {
    return and(
      eq(pendingDonationPaymentsTable.userId, userId),
      eq(pendingDonationPaymentsTable.kind, kind),
      kind === 'feature_request' && attemptId !== undefined
        ? eq(pendingDonationPaymentsTable.attemptId, attemptId)
        : undefined,
    )
  }

  /** Claim and read in one write transaction, before any asynchronous invoice lookup or mint. */
  async function reserveIssuance(
    userId: number,
    kind: 'one_shot' | 'feature_request',
    attemptId?: string,
    now = new Date(),
  ) {
    return database.transaction(
      tx => {
        const key = JSON.stringify([
          userId,
          kind,
          kind === 'feature_request' ? (attemptId ?? null) : null,
        ])
        const token: string = crypto.randomUUID()
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        const claimed = tx
          .insert(donationPaymentSlotsTable)
          .values({key, token, expiresAt})
          .onConflictDoUpdate({
            target: donationPaymentSlotsTable.key,
            set: {token, expiresAt},
            setWhere: lte(donationPaymentSlotsTable.expiresAt, now),
          })
          .returning()
          .get()
        if (!claimed) return null
        const rows = tx
          .select()
          .from(pendingDonationPaymentsTable)
          .where(pendingScope(userId, kind, attemptId))
          .all()
        return {key, token, rows}
      },
      {behavior: 'immediate'},
    )
  }

  async function releaseIssuance(slot: {key: string; token: string}) {
    await database
      .delete(donationPaymentSlotsTable)
      .where(
        and(
          eq(donationPaymentSlotsTable.key, slot.key),
          eq(donationPaymentSlotsTable.token, slot.token),
        ),
      )
  }

  /** Fence expired owners and persist the invoice BEFORE debit, including across process crashes. */
  async function saveIssued(
    slot: {key: string; token: string},
    data: NewPendingDonationPayment,
    now = new Date(),
  ) {
    return database.transaction(
      tx => {
        const owner = tx
          .select()
          .from(donationPaymentSlotsTable)
          .where(
            and(
              eq(donationPaymentSlotsTable.key, slot.key),
              eq(donationPaymentSlotsTable.token, slot.token),
              gt(donationPaymentSlotsTable.expiresAt, now),
            ),
          )
          .get()
        if (!owner) return false
        // A writer outside this lease may have installed a pending invoice while mint was in flight.
        if (
          tx
            .select()
            .from(pendingDonationPaymentsTable)
            .where(pendingScope(data.userId, data.kind, data.attemptId ?? undefined))
            .get()
        )
          return false
        tx.insert(pendingDonationPaymentsTable).values(data).run()
        return true
      },
      {behavior: 'immediate'},
    )
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
          attemptId: pending.kind === 'feature_request' ? pending.attemptId : null,
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

  async function findByAttempt(userId: number, attemptId: string) {
    return database.query.donationsTable.findFirst({
      where: and(
        eq(donationsTable.userId, userId),
        eq(donationsTable.kind, 'one_shot'),
        eq(donationsTable.attemptId, attemptId),
      ),
    })
  }

  return {
    insert,
    savePending,
    reserveIssuance,
    releaseIssuance,
    saveIssued,
    listPending,
    removePending,
    completePending,
    getUserStats,
    getPlatformStats,
    findByPaymentHash,
    findByAttempt,
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
