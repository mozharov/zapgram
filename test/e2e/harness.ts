import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {type AppContainer, createContainer} from '@bootstrap/container.js'
import type {AppDatabase} from '@infra/db/client.js'
import {limiter} from '@infra/lnbits/lnbits-api.js'
import {checkPendingInvoices} from '@modules/invoices/jobs/check-pending-invoices.js'
import {deleteExpiredInvoices} from '@modules/invoices/jobs/delete-expired-invoices.js'
import {checkExpiredSubscriptions} from '@modules/subscriptions/jobs/check-expired-subscriptions.js'
import {checkSubscriptionPayments} from '@modules/subscriptions/jobs/check-subscription-payments.js'
import {processExpiringSubscriptions} from '@modules/subscriptions/jobs/process-expiring-subscriptions.js'
import type {Update} from 'grammy/types'
import {clearRuntime} from '../../src/runtime.js'
import {registerHandlers} from '../../src/telegram/composition.js'
import {type FakeLnbits, startFakeLnbits} from './fakes/lnbits-server.js'
import {type FakeTelegram, startFakeTelegram} from './fakes/telegram-server.js'

const ADMIN_KEY = 'e2e-admin-key'
const FEE_COLLECTION_KEY = 'e2e-fee-key'

export type LogRecord = Record<string, unknown> & {level?: string | number}

export type E2E = {
  tg: FakeTelegram
  ln: FakeLnbits
  db: AppDatabase
  container: AppContainer
  logs: LogRecord[]
  send(update: Update): Promise<void>
  jobs: {
    pendingInvoices(): Promise<void>
    expiredInvoices(): Promise<void>
    subscriptionPayments(): Promise<void>
    expiredSubscriptions(): Promise<void>
    expiringSubscriptions(): Promise<void>
  }
  restart(): Promise<void>
  dispose(): Promise<void>
}

export async function createE2E(opts?: {
  mode?: 'memory' | 'file'
  env?: Partial<Record<string, string>>
}): Promise<E2E> {
  await limiter.updateSettings({
    reservoir: null,
    reservoirRefreshAmount: null,
    reservoirRefreshInterval: null,
    minTime: 0,
    maxConcurrent: null,
  })

  const ln = await startFakeLnbits({adminKey: ADMIN_KEY, feeCollectionKey: FEE_COLLECTION_KEY})
  const tg = await startFakeTelegram()
  const mode = opts?.mode ?? 'memory'
  const tempDirectory = mode === 'file' ? await mkdtemp(join(tmpdir(), 'zapgram-e2e-')) : undefined
  const dbUrl = tempDirectory ? join(tempDirectory, 'e2e.sqlite') : ':memory:'
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    BOT_TOKEN: '000000:test-token',
    BOT_WEBHOOK_SECRET: 'test-secret',
    BOT_API_ROOT: tg.url,
    DB_URL: dbUrl,
    DB_MIGRATE: 'true',
    LNBITS_URL: ln.url,
    LNBITS_ADMIN_KEY: ADMIN_KEY,
    LNBITS_FEE_COLLECTION_INVOICE_KEY: FEE_COLLECTION_KEY,
    SUBSCRIPTION_FEE_PERCENT: '0.05',
    HOST: 'https://test.local',
    CONFIGURE_BOT: 'false',
    CHAT_RIGHTS_DELAY_MS: '0',
    TEMP_MESSAGE_DELAY_MS: '5',
    ...opts?.env,
  }
  const logs: LogRecord[] = []
  const restoreStdout = interceptStdout(logs)
  let container: AppContainer | undefined

  try {
    container = await boot(env, tg)
  } catch (error) {
    restoreStdout()
    clearRuntime()
    closeDatabase(container?.db)
    ln.stop()
    tg.stop()
    if (tempDirectory) await rm(tempDirectory, {recursive: true, force: true})
    throw error
  }

  let disposed = false
  const e2e: E2E = {
    tg,
    ln,
    db: container.db,
    container,
    logs,
    send(update) {
      return e2e.container.bot.handleUpdate(update)
    },
    jobs: {
      pendingInvoices: checkPendingInvoices,
      expiredInvoices: deleteExpiredInvoices,
      subscriptionPayments: checkSubscriptionPayments,
      expiredSubscriptions: checkExpiredSubscriptions,
      expiringSubscriptions: processExpiringSubscriptions,
    },
    async restart() {
      if (mode !== 'file') {
        throw new Error("E2E restart() requires createE2E({mode: 'file'})")
      }
      if (disposed) throw new Error('Cannot restart a disposed E2E world')

      clearRuntime()
      closeDatabase(e2e.db)
      const next = await boot(env, tg)
      e2e.container = next
      e2e.db = next.db
    },
    async dispose() {
      if (disposed) return
      disposed = true
      clearRuntime()
      closeDatabase(e2e.db)
      ln.stop()
      tg.stop()
      if (tempDirectory) await rm(tempDirectory, {recursive: true, force: true})
      restoreStdout()
    },
  }
  return e2e
}

async function boot(env: Record<string, string>, tg: FakeTelegram): Promise<AppContainer> {
  const container = await createContainer(env)
  registerHandlers(container.bot)
  await container.bot.init()
  tg.reset()
  return container
}

function closeDatabase(db: AppDatabase | undefined): void {
  if (!db) return
  const client = Reflect.get(db, '$client') as {close?: () => void} | undefined
  client?.close?.()
}

function interceptStdout(logs: LogRecord[]): () => void {
  const stdout = process.stdout
  const originalWrite = stdout.write
  let buffer = ''
  let restored = false

  stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) captureLogLine(line, logs)

    const callback = args.find(argument => typeof argument === 'function')
    if (typeof callback === 'function') callback()
    return true
  }) as typeof stdout.write

  return () => {
    if (restored) return
    restored = true
    if (buffer) captureLogLine(buffer, logs)
    stdout.write = originalWrite
  }
}

function captureLogLine(line: string, logs: LogRecord[]): void {
  if (!line.trim()) return
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      logs.push(parsed as LogRecord)
    }
  } catch {
    // The harness intentionally suppresses non-NDJSON stdout while it owns the process logger.
  }
}
