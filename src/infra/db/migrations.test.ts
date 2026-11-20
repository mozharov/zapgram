import {Database} from 'bun:sqlite'
import {expect, test} from 'bun:test'
import {existsSync, readFileSync} from 'node:fs'

/**
 * Drizzle applies a journal entry only when `when` is greater than the `created_at` of the last
 * migration already recorded in the database (`sqlite-core/dialect.js`: `lastDbMigration.created_at
 * < migration.folderMillis`). `lastDbMigration` is read once, before the loop.
 *
 * So an entry whose `when` is lower than an earlier entry's applies on a fresh database and is
 * skipped **forever** on every existing one. That is how `0016_private_chat_declutter` shipped with
 * its three living-menu columns missing on dev: every `notificationChrome` query failed with
 * "no such column", each failure was swallowed by the best-effort `catch` + `warn` that keeps the
 * feature non-fatal, and the menu silently stopped being deleted. Tests could not see it because
 * every test database is created from scratch, where `lastDbMigration` is empty and all entries run.
 */

type JournalEntry = {idx: number; when: number; tag: string}

const journalUrl = new URL('../../../drizzle/meta/_journal.json', import.meta.url)
const journal = JSON.parse(readFileSync(journalUrl, 'utf8')) as {entries: JournalEntry[]}

test('migration journal timestamps strictly increase, so no entry is skipped on an existing db', () => {
  const offenders = journal.entries
    .map((entry, index) => ({entry, previous: journal.entries[index - 1]}))
    .filter(({entry, previous}) => previous !== undefined && entry.when <= previous.when)
    .map(
      ({entry, previous}) => `${entry.tag} (${entry.when}) <= ${previous?.tag} (${previous?.when})`,
    )

  expect(offenders).toEqual([])
})

test('migration journal entries are in index order and each has its sql file', () => {
  expect(journal.entries.map(entry => entry.idx)).toEqual(journal.entries.map((_, index) => index))

  const missing = journal.entries
    .map(entry => entry.tag)
    .filter(tag => !existsSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url)))

  expect(missing).toEqual([])
})

test('0027 clears legacy successful donation hashes without changing schedules or the ledger', () => {
  const sqlite = new Database(':memory:')
  const sqlFor = (tag: string) =>
    readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), 'utf8')
  try {
    for (const entry of journal.entries.filter(entry => entry.idx <= 26)) {
      sqlite.exec(sqlFor(entry.tag))
    }
    sqlite.exec(`
      INSERT INTO users (id, monthly_donation_sats, monthly_donation_next_at,
        monthly_donation_last_hash) VALUES
        (1, 50, unixepoch() - 10, 'legacy-paid'),
        (2, 0, NULL, 'legacy-disabled'),
        (3, 100, unixepoch() + 100, NULL);
      INSERT INTO donations (id, user_id, amount_sats, kind, payment_hash)
        VALUES ('previous-month', 1, 50, 'monthly', 'legacy-paid');
    `)
    const before = sqlite.query('SELECT * FROM users ORDER BY id').all() as Record<
      string,
      unknown
    >[]
    const ledger = sqlite.query('SELECT * FROM donations').all()
    sqlite.exec(sqlFor('0027_monthly_donation_pending_hash'))
    expect(sqlite.query('SELECT * FROM users ORDER BY id').all()).toEqual(
      before.map(row => ({...row, monthly_donation_last_hash: null})),
    )
    expect(sqlite.query('SELECT * FROM donations').all()).toEqual(ledger)

    const previous = JSON.parse(
      readFileSync(new URL('../../../drizzle/meta/0026_snapshot.json', import.meta.url), 'utf8'),
    )
    const current = JSON.parse(
      readFileSync(new URL('../../../drizzle/meta/0027_snapshot.json', import.meta.url), 'utf8'),
    )
    expect(current.prevId).toBe(previous.id)
    expect(current.id).not.toBe(previous.id)
    expect({...current, id: previous.id, prevId: previous.prevId}).toEqual(previous)
  } finally {
    sqlite.close()
  }
})

test('0028 upgrades 0027 with pending storage and monthly TTL while preserving existing rows', () => {
  const sqlite = new Database(':memory:')
  try {
    for (const entry of journal.entries.filter(entry => entry.idx <= 27)) {
      sqlite.exec(
        readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'),
      )
    }
    sqlite.exec(`INSERT INTO users (id, monthly_donation_last_hash) VALUES (1, 'in-flight');
      INSERT INTO donations (id, user_id, amount_sats, kind, payment_hash) VALUES
      ('a', 1, 21, 'one_shot', 'legacy-duplicate'), ('b', 1, 21, 'one_shot', 'legacy-duplicate'),
      ('c', 1, 5, 'percent', NULL), ('d', 1, 5, 'percent', NULL);`)
    const before = sqlite.query('SELECT * FROM donations ORDER BY id').all()
    sqlite.exec(
      readFileSync(
        new URL('../../../drizzle/0028_donation_payment_expiry.sql', import.meta.url),
        'utf8',
      ),
    )
    expect(
      sqlite
        .query('SELECT monthly_donation_last_hash, monthly_donation_expires_at FROM users')
        .get(),
    ).toEqual({monthly_donation_last_hash: 'in-flight', monthly_donation_expires_at: null})
    expect(sqlite.query('SELECT * FROM donations ORDER BY id').all()).toEqual(before)
    for (const hash of ['tip-a', 'tip-b'])
      sqlite
        .query(`INSERT INTO pending_donation_payments
      (payment_hash, user_id, kind, amount_sats, expires_at) VALUES (?, 1, 'percent', 5, unixepoch() + 60)`)
        .run(hash)
    expect(sqlite.query('SELECT * FROM pending_donation_payments').all()).toHaveLength(2)
    expect(() =>
      sqlite.exec(`INSERT INTO pending_donation_payments
      (payment_hash, user_id, kind, amount_sats, expires_at) VALUES ('tip-a', 1, 'percent', 5, unixepoch())`),
    ).toThrow()
    expect(() =>
      sqlite.exec(`INSERT INTO pending_donation_payments
      (payment_hash, user_id, kind, amount_sats, expires_at) VALUES ('bad', 1, 'monthly', 5, unixepoch())`),
    ).toThrow()
    const previous = JSON.parse(
      readFileSync(new URL('../../../drizzle/meta/0027_snapshot.json', import.meta.url), 'utf8'),
    )
    const current = JSON.parse(
      readFileSync(new URL('../../../drizzle/meta/0028_snapshot.json', import.meta.url), 'utf8'),
    )
    expect(current.prevId).toBe(previous.id)
    expect(current.tables.donations).toEqual(previous.tables.donations)
    expect(current.tables.pending_donation_payments.columns.payment_hash.primaryKey).toBe(true)
    expect(current.tables.users.columns.monthly_donation_expires_at.notNull).toBe(false)
  } finally {
    sqlite.close()
  }
})

test('0029 extends 0028 with nullable funding ownership and issuance slots without changing historical payments', () => {
  const sqlite = new Database(':memory:')
  const read = (path: string) =>
    readFileSync(new URL(`../../../drizzle/${path}`, import.meta.url), 'utf8')
  try {
    for (const entry of journal.entries.filter(entry => entry.idx <= 28))
      sqlite.exec(read(`${entry.tag}.sql`))
    sqlite.exec(`INSERT INTO users (id) VALUES (1);
      INSERT INTO donations (id, user_id, amount_sats, kind, payment_hash) VALUES ('old', 1, 50, 'one_shot', 'old-hash');
      INSERT INTO pending_donation_payments (payment_hash, user_id, kind, amount_sats, expires_at) VALUES
      ('legacy-feature', 1, 'feature_request', 21, unixepoch() + 60), ('tip-a', 1, 'percent', 5, unixepoch() + 60);`)
    const ledger = sqlite.query('SELECT * FROM donations').all() as Record<string, unknown>[]
    const pending = sqlite
      .query('SELECT * FROM pending_donation_payments ORDER BY payment_hash')
      .all() as Record<string, unknown>[]
    sqlite.exec(read('0029_donation_attempt_issuance.sql'))
    expect(sqlite.prepare('SELECT * FROM donations').all()).toEqual(
      ledger.map(row => ({...row, attempt_id: null})),
    )
    expect(
      sqlite.prepare('SELECT * FROM pending_donation_payments ORDER BY payment_hash').all(),
    ).toEqual(pending.map(row => ({...row, attempt_id: null})))
    sqlite.exec(`INSERT INTO pending_donation_payments (payment_hash, user_id, kind, amount_sats, expires_at, attempt_id) VALUES
      ('tip-b', 1, 'percent', 5, unixepoch() + 60, NULL),
      ('feature-a', 1, 'feature_request', 21, unixepoch() + 60, 'a'),
      ('feature-b', 1, 'feature_request', 21, unixepoch() + 60, 'b');`)
    expect(sqlite.query('SELECT * FROM pending_donation_payments').all()).toHaveLength(5)
    sqlite.exec(
      "INSERT INTO donation_payment_slots (key, token, expires_at) VALUES ('slot', 'owner', unixepoch() + 60)",
    )
    expect(() =>
      sqlite.exec(
        "INSERT INTO donation_payment_slots (key, token, expires_at) VALUES ('slot', 'other', unixepoch() + 60)",
      ),
    ).toThrow()
    const previous = JSON.parse(read('meta/0028_snapshot.json'))
    const current = JSON.parse(read('meta/0029_snapshot.json'))
    expect(previous.id).toBe('f2e09d7f-822f-4972-a1c1-d644f7b869ab')
    expect(current.prevId).toBe(previous.id)
    expect(current.id).not.toBe(previous.id)
    expect(current.tables.users).toEqual(previous.tables.users)
    expect(current.tables.pending_donation_payments.columns.attempt_id.notNull).toBe(false)
    expect(current.tables.donations.columns.attempt_id.notNull).toBe(false)
    expect(journal.entries[29]?.tag).toBe('0029_donation_attempt_issuance')
  } finally {
    sqlite.close()
  }
})
