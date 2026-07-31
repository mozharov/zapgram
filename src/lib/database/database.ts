import {Database} from 'bun:sqlite'
import {drizzle} from 'drizzle-orm/bun-sqlite'
import {migrate} from 'drizzle-orm/bun-sqlite/migrator'
import {config} from '../../config.js'
import {logger} from '../logger.js'
import * as schema from './schema.js'

const sqlite = new Database(config.DB_URL)
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec(`PRAGMA journal_size_limit = ${240 * 1024 * 1024}`) // 240mb
sqlite.exec('PRAGMA foreign_keys = ON')

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
