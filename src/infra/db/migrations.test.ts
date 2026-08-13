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
