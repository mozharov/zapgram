import {Database} from 'bun:sqlite'
import {config} from '@config'
import {type BunSQLiteDatabase, drizzle} from 'drizzle-orm/bun-sqlite'
import {migrate} from 'drizzle-orm/bun-sqlite/migrator'
import {logger} from '../logger.js'
import * as schema from './schema.js'

export type AppDatabase = BunSQLiteDatabase<typeof schema>

export function createDb(url: string): AppDatabase {
  const sqlite = new Database(url)
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run(`PRAGMA journal_size_limit = ${240 * 1024 * 1024}`) // 240mb
  sqlite.run('PRAGMA foreign_keys = ON')
  return drizzle({client: sqlite, schema})
}

export function migrateDb(database: AppDatabase, folder = './drizzle'): void {
  logger.info('Applying database migrations...')
  try {
    migrate(database, {migrationsFolder: folder})
  } catch (error) {
    logger.error({error}, 'Error applying database migrations')
    throw error
  }
  logger.info('Database migrations applied successfully')
}

/** Legacy singleton — removed in step 11 when bootstrap owns composition. */
export const db = createDb(config.DB_URL)

/** @deprecated Prefer migrateDb(db, folder). Kept for existing call sites until bootstrap. */
export function migrateDatabase(): void {
  migrateDb(db)
}
