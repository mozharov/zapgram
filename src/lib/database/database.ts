import {drizzle} from 'drizzle-orm/better-sqlite3'
import {migrate} from 'drizzle-orm/better-sqlite3/migrator'
import {config} from '../../config.js'
import Database from 'better-sqlite3'
import {logger} from '../logger.js'
import * as schema from './schema.js'

const sqlite = new Database(config.DB_URL)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma(`journal_size_limit = ${240 * 1024 * 1024}`) // 240mb
sqlite.pragma('foreign_keys = ON')

export const db = drizzle({client: sqlite, schema})

export function migrateDatabase(): void {
  logger.info('Applying database migrations...')
  try {
    migrate(db, {migrationsFolder: './drizzle'})
  } catch (error) {
    logger.error({error}, 'Error applying database migrations')
    throw error
  }
  logger.info('Database migrations applied successfully')
}
