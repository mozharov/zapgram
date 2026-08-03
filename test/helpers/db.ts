import {Database} from 'bun:sqlite'
import type {AppDatabase} from '@infra/db/client.js'
import * as schema from '@infra/db/schema.js'
import {drizzle} from 'drizzle-orm/bun-sqlite'
import {migrate} from 'drizzle-orm/bun-sqlite/migrator'

/**
 * In-memory SQLite with real project migrations applied.
 * Each call gets a fresh empty database.
 */
export function createTestDb(): AppDatabase {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle({client: sqlite, schema})
  migrate(db, {migrationsFolder: './drizzle'})
  return db
}
