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
