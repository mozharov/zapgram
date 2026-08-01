import {sql} from 'drizzle-orm'
import {index, integer, sqliteTable, text} from 'drizzle-orm/sqlite-core'

export const usersTable = sqliteTable(
  'users',
  {
    id: integer('id', {mode: 'number'}).primaryKey(), // Telegram ID
    username: text('username'),
    firstName: text('first_name'),
    languageCode: text('language_code').notNull().default('en'),
    nwcTips: integer('nwc_tips', {mode: 'boolean'}).notNull().default(false),
    nwcUrl: text('nwc_url'),
    createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
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
  createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
})

// only for paid chats
export const chatsTable = sqliteTable('chats', {
  id: integer('id', {mode: 'number'}).primaryKey(), // Telegram ID
  title: text('title').notNull(),
  type: text('type', {enum: ['channel', 'supergroup']}).notNull(),
  price: integer('price', {mode: 'number'}).notNull().default(1000), // Price for subscription in satoshis
  status: text('status', {enum: ['active', 'inactive', 'no_access']}) // no_access - bot was removed from the chat or rights were changed
    .notNull()
    .default('inactive'),
  paymentType: text('payment_type', {enum: ['one_time', 'monthly']})
    .notNull()
    .default('one_time'),
  ownerId: integer('owner_id', {mode: 'number'})
    .notNull()
    .references(() => usersTable.id, {onDelete: 'cascade'}),
  customMessageEn: text('custom_message_en'),
  customMessageRu: text('custom_message_ru'),
  createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
})

export const subscriptionsTable = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: integer('user_id', {mode: 'number'})
    .notNull()
    .references(() => usersTable.id, {onDelete: 'cascade'}),
  chatId: integer('chat_id', {mode: 'number'})
    .notNull()
    .references(() => chatsTable.id, {onDelete: 'cascade'}),
  price: integer('price', {mode: 'number'}).notNull(), // satoshis
  endsAt: integer('ends_at', {mode: 'timestamp'}), // if null - permanent access
  autoRenew: integer('auto_renew', {mode: 'boolean'}).notNull().default(true),
  notificationSent: integer('notification_sent', {mode: 'boolean'}).notNull().default(false), // if true, notification about expiration was sent
  createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
})

export const subscriptionPaymentsTable = sqliteTable('subscription_payments', {
  id: text('id').primaryKey(),
  userId: integer('user_id', {mode: 'number'})
    .notNull()
    .references(() => usersTable.id, {onDelete: 'cascade'}),
  chatId: integer('chat_id', {mode: 'number'})
    .notNull()
    .references(() => chatsTable.id, {onDelete: 'cascade'}),
  paymentRequest: text('payment_request').notNull(),
  paymentHash: text('payment_hash').notNull(), // lnbits payment hash
  price: integer('price', {mode: 'number'}).notNull(), // satoshis
  subscriptionType: text('subscription_type', {enum: ['one_time', 'monthly']}).notNull(),
  /**
   * Whether this payment buys initial access or extends an existing subscription. Only used to pick
   * the right message once it settles — telling a renewing subscriber they "received access" reads
   * as if something was wrong.
   */
  kind: text('kind', {enum: ['join', 'renewal']})
    .notNull()
    .default('join'),
  /** Set when chat access has been granted; prevents double-extend on settle retry. */
  settledAt: integer('settled_at', {mode: 'timestamp'}),
  /**
   * Settle attempts made after the invoice was confirmed paid. Once it reaches
   * MAX_SETTLE_ATTEMPTS the cron stops picking the payment up, but the row is kept for review.
   */
  settleAttempts: integer('settle_attempts', {mode: 'number'}).notNull().default(0),
  /**
   * payment_hash of the owner payout invoice, written *before* it is paid. On a retry it lets us
   * ask LNbits whether that payout already went through instead of issuing a second one.
   */
  payoutHash: text('payout_hash'),
  /** Same idea as payoutHash, for the master → fee-collection wallet transfer. */
  feePayoutHash: text('fee_payout_hash'),
  createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
})
