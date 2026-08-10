import {AppError} from '@core/errors/app-error.js'
import {matchesAppLocale} from '@core/i18n/language-code-match.js'
import type {AppLocale} from '@core/i18n/locale.js'
import type {AppDatabase} from '@infra/db/client.js'
import {usersTable} from '@infra/db/schema.js'
import type {NewUser, User} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, eq, isNotNull, lte, ne, sql} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

export type UserRepositoryOptions = {
  /** Applied only on first insert via getOrCreate — not on profile refresh. */
  defaultDonationPercent?: number
}

export function createUserRepository(database: AppDatabase, options: UserRepositoryOptions = {}) {
  const defaultDonationPercent = options.defaultDonationPercent ?? 0

  async function findById(id: User['id']) {
    return database.query.usersTable.findFirst({where: eq(usersTable.id, id)})
  }

  async function createOrUpdate(data: NewUser) {
    const values = {
      ...data,
      username: data.username?.toLowerCase(),
    }
    return database
      .insert(usersTable)
      .values(values)
      .onConflictDoUpdate({
        target: usersTable.id,
        set: values,
      })
      .returning()
      .then(rows => firstOrThrow(rows, 'user'))
  }

  return {
    findById,

    async findByUsername(username: string) {
      const user = await database.query.usersTable.findFirst({
        where: eq(usersTable.username, username.toLowerCase()),
      })
      return user as (User & {username: string}) | null | undefined
    },

    async getOrThrow(id: User['id']) {
      const user = await findById(id)
      if (!user) throw new AppError('not_found', {message: `User ${id} not found`})
      return user
    },

    /**
     * Returns the stored user, refreshing it when Telegram reports a changed profile.
     *
     * The refresh is load-bearing: `findByUsername` (used by `/tip @name`) reads the stored
     * username, so a stale row makes tips fail — or, once someone else takes the old handle,
     * routes sats to the wrong person.
     *
     * New inserts get `DONATION_DEFAULT_PERCENT` (and scope `all`); existing users keep their
     * donation settings on profile refresh.
     */
    async getOrCreate(data: NewUser) {
      const existing = await findById(data.id)
      if (!existing) {
        return createOrUpdate({
          ...data,
          donationPercent: data.donationPercent ?? defaultDonationPercent,
          donationScope: data.donationScope ?? 'all',
        })
      }

      const username = data.username?.toLowerCase()
      const isCurrent =
        (username === undefined || existing.username === username) &&
        (data.firstName === undefined || existing.firstName === data.firstName) &&
        (data.languageCode === undefined || existing.languageCode === data.languageCode)

      return isCurrent ? existing : createOrUpdate(data)
    },

    createOrUpdate,

    async update(id: User['id'], data: Partial<User>) {
      const values = {
        ...data,
        ...(data.username !== undefined ? {username: data.username?.toLowerCase()} : {}),
      }
      return database
        .update(usersTable)
        .set(values)
        .where(eq(usersTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `User ${id}`))
    },

    async countDueMonthlyDonations(now: Date = new Date()) {
      const [row] = await database
        .select({count: sql<number>`count(*)`})
        .from(usersTable)
        .where(
          and(
            sql`${usersTable.monthlyDonationSats} > 0`,
            isNotNull(usersTable.monthlyDonationNextAt),
            lte(usersTable.monthlyDonationNextAt, now),
          ),
        )
      return Number(row?.count ?? 0)
    },

    async findDueMonthlyDonations(limit: number, offset: number, now: Date = new Date()) {
      return database.query.usersTable.findMany({
        where: and(
          sql`${usersTable.monthlyDonationSats} > 0`,
          isNotNull(usersTable.monthlyDonationNextAt),
          lte(usersTable.monthlyDonationNextAt, now),
        ),
        limit,
        offset,
        orderBy: (t, {asc}) => [asc(t.monthlyDonationNextAt)],
      })
    },

    async setBotBlocked(id: User['id'], botBlocked: boolean) {
      return database
        .update(usersTable)
        .set({botBlocked})
        .where(eq(usersTable.id, id))
        .returning()
        .then(rows => firstOrThrow(rows, `User ${id}`))
    },

    /**
     * User ids eligible for a locale broadcast: not blocked, locale match, exclude launcher.
     * Locale uses the same primary-language rule as `resolveAppLocale` (ru → ru, else en).
     */
    async listBroadcastRecipientIds(opts: {
      locale: AppLocale
      excludeUserId: number
    }): Promise<number[]> {
      const rows = await database
        .select({
          id: usersTable.id,
          languageCode: usersTable.languageCode,
        })
        .from(usersTable)
        .where(and(eq(usersTable.botBlocked, false), ne(usersTable.id, opts.excludeUserId)))

      return rows.filter(row => matchesAppLocale(row.languageCode, opts.locale)).map(row => row.id)
    },
  }
}

export type UserRepository = ReturnType<typeof createUserRepository>

export const getOrCreateUser = (data: NewUser) => getRuntime().users.getOrCreate(data)
export const getUserOrThrow = (id: User['id']) => getRuntime().users.getOrThrow(id)
export const getUserByUsername = (username: string) => getRuntime().users.findByUsername(username)
export const createOrUpdateUser = (data: NewUser) => getRuntime().users.createOrUpdate(data)
export const updateUser = (id: User['id'], data: Partial<User>) =>
  getRuntime().users.update(id, data)
export const setUserBotBlocked = (id: User['id'], botBlocked: boolean) =>
  getRuntime().users.setBotBlocked(id, botBlocked)
