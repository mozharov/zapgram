import {Database} from 'bun:sqlite'
import {type BunSQLiteDatabase, drizzle} from 'drizzle-orm/bun-sqlite'
import {migrate} from 'drizzle-orm/bun-sqlite/migrator'
import type {AppLogger} from '../logger.js'
import * as schema from './schema.js'

export type AppDatabase = BunSQLiteDatabase<typeof schema>

export function createDb(url: string): AppDatabase {
  const sqlite = new Database(url)
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run(`PRAGMA journal_size_limit = ${240 * 1024 * 1024}`) // 240mb
  sqlite.run('PRAGMA foreign_keys = ON')
  return drizzle({client: sqlite, schema})
}

export function migrateDb(database: AppDatabase, folder = './drizzle', log?: AppLogger): void {
  log?.info('Applying database migrations...')
  try {
    migrate(database, {migrationsFolder: folder})
  } catch (error) {
    log?.error({error}, 'Error applying database migrations')
    throw error
  }
  log?.info('Database migrations applied successfully')
}
