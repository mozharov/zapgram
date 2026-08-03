import {Database} from 'bun:sqlite'
import {describe, expect, test} from 'bun:test'
import {readdirSync, readFileSync} from 'node:fs'

const migrationsDirectory = new URL('../../../drizzle/', import.meta.url)

function migrationSql(name: string): string {
  return readFileSync(new URL(name, migrationsDirectory), 'utf8')
}

function runMigrationSql(sqlite: Database, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.query(statement).run()
  }
}

function createDatabaseBeforeMigration(): Database {
  const sqlite = new Database(':memory:')
  const oldMigrations = readdirSync(migrationsDirectory)
    .filter(name => name.endsWith('.sql') && name < '0011_')
    .sort()
  for (const name of oldMigrations) runMigrationSql(sqlite, migrationSql(name))
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec("INSERT INTO users (id, first_name) VALUES (1, 'Owner'), (2, 'Subscriber')")
  sqlite.exec(`
    INSERT INTO chats (id, title, type, owner_id)
    VALUES (-100, 'Paid Chat', 'supergroup', 1)
  `)
  return sqlite
}

function runMigration0011(sqlite: Database): void {
  sqlite.exec('BEGIN')
  try {
    runMigrationSql(sqlite, migrationSql('0011_subscription_intents.sql'))
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

function expectMigrationRollback(sqlite: Database): void {
  const tables = sqlite
    .query<{name: string}, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(row => row.name)
  const paymentColumns = sqlite
    .query<{name: string}, []>('PRAGMA table_info(subscription_payments)')
    .all()
    .map(row => row.name)

  expect(tables).not.toContain('subscription_intents')
  expect(tables).not.toContain('__new_subscription_payments')
  expect(paymentColumns).not.toContain('intent_id')
}

function insertPayment(
  sqlite: Database,
  values: {id: string; paymentRequest: string; paymentHash: string},
): void {
  sqlite
    .query(`
      INSERT INTO subscription_payments (
        id, user_id, chat_id, payment_request, payment_hash, price, subscription_type, kind,
        settled_at, settle_attempts, payout_hash, fee_payout_hash, created_at
      ) VALUES (?, 2, -100, ?, ?, 1000, 'monthly', 'renewal', 1700000100, 7, ?, ?, 1700000000)
    `)
    .run(
      values.id,
      values.paymentRequest,
      values.paymentHash,
      `payout-${values.id}`,
      `fee-${values.id}`,
    )
}

describe('subscription intents migration', () => {
  test('backfills one legacy intent per payment without losing money state', () => {
    const sqlite = createDatabaseBeforeMigration()
    insertPayment(sqlite, {id: 'payment-1', paymentRequest: 'lnbc-1', paymentHash: 'hash-1'})

    runMigration0011(sqlite)

    expect(
      sqlite
        .query(`
          SELECT id, user_id, chat_id, kind, status, winner_attempt_id, created_at, updated_at
          FROM subscription_intents
        `)
        .get(),
    ).toEqual({
      id: 'payment-1',
      user_id: 2,
      chat_id: -100,
      kind: 'renewal',
      status: 'legacy',
      winner_attempt_id: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    })
    expect(
      sqlite
        .query(`
          SELECT intent_id, expires_at, is_current, attempt_status, processed_at, settled_at,
                 settle_attempts, payout_hash, fee_payout_hash, refund_payout_hash, refunded_at
          FROM subscription_payments
        `)
        .get(),
    ).toEqual({
      intent_id: 'payment-1',
      expires_at: null,
      is_current: 1,
      attempt_status: 'pending',
      processed_at: null,
      settled_at: 1700000100,
      settle_attempts: 7,
      payout_hash: 'payout-payment-1',
      fee_payout_hash: 'fee-payment-1',
      refund_payout_hash: null,
      refunded_at: null,
    })

    sqlite.close()
  })

  test('preserves multiple unfinished payments for one user/chat pair as separate intents', () => {
    const sqlite = createDatabaseBeforeMigration()
    insertPayment(sqlite, {id: 'payment-1', paymentRequest: 'lnbc-1', paymentHash: 'hash-1'})
    insertPayment(sqlite, {id: 'payment-2', paymentRequest: 'lnbc-2', paymentHash: 'hash-2'})

    runMigration0011(sqlite)

    expect(
      sqlite
        .query(`
          SELECT payment.id AS payment_id, payment.intent_id, intent.status
          FROM subscription_payments AS payment
          JOIN subscription_intents AS intent ON intent.id = payment.intent_id
          ORDER BY payment.id
        `)
        .all(),
    ).toEqual([
      {payment_id: 'payment-1', intent_id: 'payment-1', status: 'legacy'},
      {payment_id: 'payment-2', intent_id: 'payment-2', status: 'legacy'},
    ])

    sqlite.close()
  })

  test('aborts and rolls back when subscriptions contain duplicate user/chat pairs', () => {
    const sqlite = createDatabaseBeforeMigration()
    sqlite.exec(`
      INSERT INTO subscriptions (id, user_id, chat_id, price)
      VALUES ('subscription-1', 2, -100, 1000), ('subscription-2', 2, -100, 1000)
    `)

    expect(() => runMigration0011(sqlite)).toThrow('migration_0011_duplicate_subscriptions')
    expectMigrationRollback(sqlite)
    expect(sqlite.query('SELECT count(*) AS count FROM subscriptions').get()).toEqual({count: 2})

    sqlite.close()
  })

  test('aborts and rolls back when payment requests are duplicated', () => {
    const sqlite = createDatabaseBeforeMigration()
    insertPayment(sqlite, {id: 'payment-1', paymentRequest: 'lnbc-same', paymentHash: 'hash-1'})
    insertPayment(sqlite, {id: 'payment-2', paymentRequest: 'lnbc-same', paymentHash: 'hash-2'})

    expect(() => runMigration0011(sqlite)).toThrow('migration_0011_duplicate_payment_requests')
    expectMigrationRollback(sqlite)
    expect(sqlite.query('SELECT count(*) AS count FROM subscription_payments').get()).toEqual({
      count: 2,
    })

    sqlite.close()
  })

  test('aborts and rolls back when payment hashes are duplicated', () => {
    const sqlite = createDatabaseBeforeMigration()
    insertPayment(sqlite, {id: 'payment-1', paymentRequest: 'lnbc-1', paymentHash: 'hash-same'})
    insertPayment(sqlite, {id: 'payment-2', paymentRequest: 'lnbc-2', paymentHash: 'hash-same'})

    expect(() => runMigration0011(sqlite)).toThrow('migration_0011_duplicate_payment_hashes')
    expectMigrationRollback(sqlite)
    expect(sqlite.query('SELECT count(*) AS count FROM subscription_payments').get()).toEqual({
      count: 2,
    })

    sqlite.close()
  })
})
