import {expect, test} from 'bun:test'
import {createConfig} from '@config'
import * as schema from '@infra/db/schema.js'
import {createScheduler, type JobDefinition} from '@jobs/scheduler.js'
import {getTableColumns, getTableName, is} from 'drizzle-orm'
import {SQLiteTable} from 'drizzle-orm/sqlite-core'
import {getRuntime} from '../../../src/runtime.js'
import {USER_A} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {createE2E, type E2E} from '../harness.js'

/**
 * Process lifecycle outside request handling: migrations land the full schema, a dead LNbits
 * refuses to publish a half-ready runtime, bad env fails with a readable parse error, and
 * `createScheduler().stop()` drains (or times out on) in-flight ticks.
 *
 * `createApp` is deliberately not used here — it starts `runOnInit` cron jobs that would race the
 * rest of the suite. The scheduler is exercised through `createScheduler` with its own job list,
 * matching how the composition root wires it.
 */

const APP_TABLES = Object.values(schema)
  .filter(value => is(value, SQLiteTable))
  .map(table => ({
    name: getTableName(table),
    columns: Object.values(getTableColumns(table))
      .map(column => column.name)
      .sort(),
  }))
  .sort((left, right) => left.name.localeCompare(right.name))

// --- Migrations ---

test('createContainer applies migrations whose tables and columns match the schema', async () => {
  const e2e = await createE2E({mode: 'file', env: {LOG_LEVEL: 'info'}})
  try {
    const live = liveSchema(e2e)
    expect(live.map(table => table.name)).toEqual(APP_TABLES.map(table => table.name))
    expect(live).toEqual(APP_TABLES)

    expect(
      e2e.logs.some(
        log =>
          log.msg === 'Database migrations applied successfully' ||
          log.msg === 'Applying database migrations...',
      ),
    ).toBe(true)
  } finally {
    await e2e.dispose()
  }
})

test('a second migrate on the same database is idempotent and keeps data', async () => {
  const e2e = await createE2E({mode: 'file', env: {LOG_LEVEL: 'info'}})
  try {
    await seedUser(e2e, {
      id: USER_A,
      username: 'user_a',
      firstName: 'User A',
      languageCode: 'en',
    })
    const schemaBefore = liveSchema(e2e)
    const migrateLogsBefore = migrationLogCount(e2e)

    await e2e.restart()

    expect(liveSchema(e2e)).toEqual(schemaBefore)
    expect(migrationLogCount(e2e)).toBeGreaterThan(migrateLogsBefore)
    // Seeded user survives the reopened file DB; migrate did not wipe or rebuild empty.
    const users = await e2e.db.select().from(schema.usersTable)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({id: USER_A, username: 'user_a'})
    expect(e2e.logs.filter(log => log.level === 'error' || log.level === 50)).toEqual([])
  } finally {
    await e2e.dispose()
  }
})

// --- Failed boot ---

test('an unreachable LNbits fails checkStatus without publishing the runtime', async () => {
  await expect(createE2E({env: {LNBITS_URL: 'http://127.0.0.1:9'}})).rejects.toThrow()

  // createContainer never reached setRuntime — leaf code must not see a half-built world.
  expect(() => getRuntime()).toThrow(/Runtime is not initialized/)
})

test('invalid env fails with a readable error that names the missing fields', () => {
  let error: unknown
  try {
    createConfig({NODE_ENV: 'test'} as NodeJS.ProcessEnv)
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(Error)
  const message = String(error)
  expect(message).toMatch(/Invalid environment variables/)
  for (const field of [
    'BOT_TOKEN',
    'BOT_WEBHOOK_SECRET',
    'DB_URL',
    'LNBITS_URL',
    'LNBITS_ADMIN_KEY',
    'LNBITS_FEE_COLLECTION_INVOICE_KEY',
    'HOST',
  ]) {
    expect(message).toContain(field)
  }
})

// --- Scheduler drain (composition-root shape, custom job list — not createApp) ---

test('scheduler.stop waits for an in-flight tick to finish', async () => {
  let resolveTick!: () => void
  const tickStarted = Promise.withResolvers<void>()
  const tickGate = new Promise<void>(resolve => {
    resolveTick = resolve
  })
  let tickFinished = false

  const jobs: JobDefinition[] = [
    {
      name: 'lifecycle-slow-job',
      cronTime: '0 0 0 1 1 *',
      runOnInit: true,
      tick: async () => {
        tickStarted.resolve()
        await tickGate
        tickFinished = true
      },
    },
  ]

  const scheduler = createScheduler(jobs, silentLog())
  scheduler.start()
  await tickStarted.promise
  expect(tickFinished).toBe(false)
  expect(scheduler.getRunningTicks()).toHaveLength(1)

  setTimeout(() => resolveTick(), 30)
  const stopStarted = Date.now()
  const {drained} = await scheduler.stop({drainTimeoutMs: 5_000})
  const elapsed = Date.now() - stopStarted

  expect(drained).toBe(true)
  expect(tickFinished).toBe(true)
  expect(elapsed).toBeGreaterThanOrEqual(20)
  expect(scheduler.getRunningTicks()).toHaveLength(0)
})

test('scheduler.stop times out when a tick never finishes', async () => {
  const tickStarted = Promise.withResolvers<void>()
  const jobs: JobDefinition[] = [
    {
      name: 'lifecycle-stuck-job',
      cronTime: '0 0 0 1 1 *',
      runOnInit: true,
      tick: async () => {
        tickStarted.resolve()
        await new Promise(() => {})
      },
    },
  ]

  const scheduler = createScheduler(jobs, silentLog())
  scheduler.start()
  await tickStarted.promise

  const {drained} = await scheduler.stop({drainTimeoutMs: 50})
  expect(drained).toBe(false)
})

// --- helpers ---

type LiveTable = {name: string; columns: string[]}

function liveSchema(e2e: E2E): LiveTable[] {
  const client = sqliteClient(e2e)
  const tables = client
    .query(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '__drizzle%'
       ORDER BY name`,
    )
    .all() as {name: string}[]

  return tables.map(table => {
    const columns = client.query(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as {
      name: string
    }[]
    return {
      name: table.name,
      columns: columns.map(column => column.name).sort(),
    }
  })
}

function sqliteClient(e2e: E2E): {
  query: (sql: string) => {all: () => unknown[]}
} {
  const client = Reflect.get(e2e.db, '$client') as
    | {query: (sql: string) => {all: () => unknown[]}}
    | undefined
  if (!client?.query) throw new Error('AppDatabase has no $client.query for schema inspection')
  return client
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe table name: ${name}`)
  return `"${name}"`
}

function migrationLogCount(e2e: E2E): number {
  return e2e.logs.filter(
    log =>
      log.msg === 'Applying database migrations...' ||
      log.msg === 'Database migrations applied successfully',
  ).length
}

function silentLog() {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: () => silentLog(),
  }
}
