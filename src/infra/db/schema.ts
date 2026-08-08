import {sql} from 'drizzle-orm'
import {check, index, integer, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core'

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
  /** When true and watchonlyWalletId is set, members may pay on-chain. */
  onchainEnabled: integer('onchain_enabled', {mode: 'boolean'}).notNull().default(false),
  /** Admin zpub/xpub as pasted (display / recreate). */
  onchainMasterpub: text('onchain_masterpub'),
  /** LNbits Watch-Only wallet id that receives on-chain payments for this chat. */
  watchonlyWalletId: text('watchonly_wallet_id'),
  /** Fingerprint returned by Watch-Only on wallet create. */
  onchainFingerprint: text('onchain_fingerprint'),
  createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
})

export const subscriptionsTable = sqliteTable(
  'subscriptions',
  {
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
  },
  table => [uniqueIndex('subscriptions_user_chat_unique').on(table.userId, table.chatId)],
)

export const subscriptionIntentsTable = sqliteTable(
  'subscription_intents',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id', {mode: 'number'})
      .notNull()
      .references(() => usersTable.id, {onDelete: 'cascade'}),
    chatId: integer('chat_id', {mode: 'number'})
      .notNull()
      .references(() => chatsTable.id, {onDelete: 'cascade'}),
    kind: text('kind', {enum: ['join', 'renewal']}).notNull(),
    status: text('status', {enum: ['legacy', 'open', 'won', 'completed']})
      .notNull()
      .default('open'),
    winnerAttemptId: text('winner_attempt_id'),
    attemptReservationId: text('attempt_reservation_id'),
    attemptReservationExpiresAt: integer('attempt_reservation_expires_at', {mode: 'timestamp'}),
    createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
  },
  table => [
    check(
      'subscription_intents_status_check',
      sql`${table.status} in ('legacy', 'open', 'won', 'completed')`,
    ),
    check(
      'subscription_intents_winner_check',
      sql`(${table.status} in ('legacy', 'open') and ${table.winnerAttemptId} is null)
          or (${table.status} in ('won', 'completed') and ${table.winnerAttemptId} is not null)`,
    ),
    check(
      'subscription_intents_reservation_check',
      sql`(${table.attemptReservationId} is null and ${table.attemptReservationExpiresAt} is null)
          or (${table.status} = 'open' and ${table.attemptReservationId} is not null
              and ${table.attemptReservationExpiresAt} is not null)`,
    ),
    uniqueIndex('subscription_intents_active_user_chat_kind_unique')
      .on(table.userId, table.chatId, table.kind)
      .where(sql`${table.status} in ('open', 'won')`),
  ],
)

export const subscriptionPaymentsTable = sqliteTable(
  'subscription_payments',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => subscriptionIntentsTable.id, {onDelete: 'cascade'}),
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
    expiresAt: integer('expires_at', {mode: 'timestamp'}),
    isCurrent: integer('is_current', {mode: 'boolean'}).notNull().default(true),
    attemptStatus: text('attempt_status', {enum: ['pending', 'processed', 'expired']})
      .notNull()
      .default('pending'),
    processedAt: integer('processed_at', {mode: 'timestamp'}),
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
    /** Must be persisted before refunding a duplicate paid attempt. */
    refundPayoutHash: text('refund_payout_hash'),
    refundedAt: integer('refunded_at', {mode: 'timestamp'}),
    createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
  },
  table => [
    check(
      'subscription_payments_status_check',
      sql`${table.attemptStatus} in ('pending', 'processed', 'expired')`,
    ),
    check(
      'subscription_payments_processed_check',
      sql`${table.attemptStatus} = 'pending' or ${table.processedAt} is not null`,
    ),
    check(
      'subscription_payments_refund_check',
      sql`${table.refundedAt} is null
          or (${table.refundPayoutHash} is not null and ${table.processedAt} is not null)`,
    ),
    uniqueIndex('subscription_payments_payment_request_unique').on(table.paymentRequest),
    uniqueIndex('subscription_payments_payment_hash_unique').on(table.paymentHash),
    uniqueIndex('subscription_payments_current_intent_unique')
      .on(table.intentId)
      .where(sql`${table.isCurrent} = 1`),
  ],
)

/**
 * On-chain join attempts via SatsPay + Watch-Only.
 * Grant wiring may link `subscriptionPaymentId` once access is completed.
 */
export const onchainChatPaymentsTable = sqliteTable(
  'onchain_chat_payments',
  {
    id: text('id').primaryKey(),
    chatId: integer('chat_id', {mode: 'number'})
      .notNull()
      .references(() => chatsTable.id, {onDelete: 'cascade'}),
    userId: integer('user_id', {mode: 'number'})
      .notNull()
      .references(() => usersTable.id, {onDelete: 'cascade'}),
    satspayChargeId: text('satspay_charge_id').notNull(),
    address: text('address').notNull(),
    amountSats: integer('amount_sats', {mode: 'number'}).notNull(),
    status: text('status', {
      enum: ['pending', 'grace', 'paid', 'expired', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    /** UI TTL (edit message “expired”). */
    expiresAt: integer('expires_at', {mode: 'timestamp'}).notNull(),
    /** Keep polling / accepting late payment until this time. */
    watchUntil: integer('watch_until', {mode: 'timestamp'}).notNull(),
    paidAt: integer('paid_at', {mode: 'timestamp'}),
    txid: text('txid'),
    telegramChatId: integer('telegram_chat_id', {mode: 'number'}),
    telegramMessageId: integer('telegram_message_id', {mode: 'number'}),
    /** Linked LN-shaped subscription_payments row used for grant/intent. */
    subscriptionPaymentId: text('subscription_payment_id').references(
      () => subscriptionPaymentsTable.id,
      {onDelete: 'set null'},
    ),
    createdAt: integer('created_at', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
  },
  table => [
    check(
      'onchain_chat_payments_status_check',
      sql`${table.status} in ('pending', 'grace', 'paid', 'expired', 'cancelled')`,
    ),
    uniqueIndex('onchain_chat_payments_satspay_charge_id_unique').on(table.satspayChargeId),
    index('onchain_chat_payments_open_idx').on(table.status, table.watchUntil),
    index('onchain_chat_payments_user_chat_idx').on(table.userId, table.chatId),
  ],
)
