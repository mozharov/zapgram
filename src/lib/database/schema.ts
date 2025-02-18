import {sql} from 'drizzle-orm'
import {text, integer, sqliteTable, index} from 'drizzle-orm/sqlite-core'

export const usersTable = sqliteTable(
  'users',
  {
    id: integer('id', {mode: 'number'}).primaryKey(), // Telegram ID
    username: text('username'),
    firstName: text('first_name'),
    languageCode: text('language_code').notNull().default('en'),
    nwcTips: integer('nwc_tips', {mode: 'boolean'}).notNull().default(false),
    nwcUrl: text('nwc_url'),
    createdAt: integer('created_at', {mode: 'timestamp'})
      .notNull()
      .default(sql`(unixepoch())`),
  },
  table => [index('username_idx').on(table.username)],
)

export const conversationsTable = sqliteTable('conversations', {
  key: text('key').primaryKey(),
  version: text('version', {mode: 'json'}).notNull(),
  state: text('state', {mode: 'json'}).notNull(),
})

export const pendingInvoicesTable = sqliteTable('pending_invoices', {
  paymentRequest: text('payment_request').primaryKey(),
  paymentHash: text('payment_hash').notNull(), // lnbits payment hash
  userId: integer('user_id', {mode: 'number'})
    .notNull()
    .references(() => usersTable.id, {onDelete: 'cascade'}),
  expiresAt: integer('expires_at', {mode: 'timestamp'})
    .notNull()
    .default(sql`(unixepoch() + 60 * 60 * 24 * 7)`), // 7 days
  createdAt: integer('created_at', {mode: 'timestamp'})
    .notNull()
    .default(sql`(unixepoch())`),
})
