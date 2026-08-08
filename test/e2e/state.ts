import * as schema from '@infra/db/schema.js'
import type {
  Chat,
  Conversation,
  OnchainChatPayment,
  PendingInvoice,
  Subscription,
  SubscriptionIntent,
  SubscriptionPayment,
  User,
} from '@infra/db/types.js'
import {getTableName, is} from 'drizzle-orm'
import {SQLiteTable} from 'drizzle-orm/sqlite-core'
import type {TgCall} from './fakes/telegram-server.js'
import type {E2E} from './harness.js'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export type WorldState = {
  db: {
    users: User[]
    chats: Chat[]
    subscriptions: Subscription[]
    subscriptionIntents: SubscriptionIntent[]
    subscriptionPayments: SubscriptionPayment[]
    pendingInvoices: PendingInvoice[]
    conversations: Conversation[]
    onchainChatPayments: OnchainChatPayment[]
  }
  lnbits: {
    wallets: {id: string; name: string; balanceMsat: number}[]
    payments: {
      hash: string
      walletId: string
      amountMsat: number
      out: boolean
      paid: boolean
    }[]
  }
  telegram: TgCall[]
}

type DbKey = keyof WorldState['db']
type RowDelta = {before?: unknown; after?: unknown}
type DbExpectation = {
  added?: number
  removed?: number
  changed?: number
  match?: (rows: RowDelta[]) => void
}

export async function snapshot(e2e: E2E): Promise<WorldState> {
  const db = emptyDbState()
  // Tables only: schema.js may also export indexes, relations or helpers, and those are not rows.
  // A genuinely new table still throws in dbKey() — WorldState must learn about it deliberately.
  for (const table of Object.values(schema).filter(value => is(value, SQLiteTable))) {
    const key = dbKey(getTableName(table))
    const rows = await selectAll(e2e, table)
    Reflect.set(db, key, normalizeDbRows(rows))
  }

  const ledger = e2e.ln.state.snapshot()
  return {
    db,
    lnbits: {
      wallets: ledger.wallets
        .map(({id, name, balanceMsat}) => ({id, name, balanceMsat}))
        .sort((left, right) => left.id.localeCompare(right.id)),
      payments: ledger.payments
        .map(payment => ({
          hash: payment.paymentHash,
          walletId: payment.walletId,
          amountMsat: payment.amountMsat,
          out: payment.out,
          paid: payment.paid,
        }))
        .sort((left, right) => paymentKey(left).localeCompare(paymentKey(right))),
    },
    telegram: e2e.tg.calls.map(call => ({
      method: call.method,
      payload: normalizeTelegramValue(call.payload) as Record<string, unknown>,
    })),
  }
}

export async function expectDelta(
  e2e: E2E,
  action: () => Promise<void>,
  expected: {
    db?: Partial<Record<DbKey, DbExpectation>>
    lnbits?: {
      balances?: Record<string, number>
      payments?: {out: boolean; sats: number; times: number}[]
    }
    telegram?: string[] | {method: string; to?: number; text?: RegExp}[]
  },
): Promise<void> {
  const before = await snapshot(e2e)
  await action()
  const after = await snapshot(e2e)

  assertDbDelta(before, after, expected.db ?? {})
  assertBalanceDelta(before, after, expected.lnbits?.balances ?? {})
  assertPaymentDelta(before, after, expected.lnbits?.payments ?? [])
  assertTelegramDelta(before, after, expected.telegram ?? [])
}

export function expectLedgerBalanced(before: WorldState, after: WorldState): void {
  const beforeTotal = before.lnbits.wallets.reduce((sum, wallet) => sum + wallet.balanceMsat, 0)
  const afterTotal = after.lnbits.wallets.reduce((sum, wallet) => sum + wallet.balanceMsat, 0)
  if (beforeTotal !== afterTotal) {
    throw new Error(
      `LNbits ledger is not balanced: total changed by ${afterTotal - beforeTotal} msat ` +
        `(before ${beforeTotal}, after ${afterTotal})`,
    )
  }
}

function assertDbDelta(
  before: WorldState,
  after: WorldState,
  expected: Partial<Record<DbKey, DbExpectation>>,
): void {
  for (const key of Object.keys(before.db) as DbKey[]) {
    const expectation = expected[key]
    const beforeRows = before.db[key] as unknown[]
    const afterRows = after.db[key] as unknown[]
    if (!expectation) {
      if (!Bun.deepEquals(beforeRows, afterRows)) {
        throw new Error(
          `Unexpected DB change in ${key}: ${format({before: beforeRows, after: afterRows})}`,
        )
      }
      continue
    }

    const delta = diffRows(key, beforeRows, afterRows)
    assertCount(`${key}.added`, delta.added.length, expectation.added ?? 0, delta.added)
    assertCount(`${key}.removed`, delta.removed.length, expectation.removed ?? 0, delta.removed)
    assertCount(`${key}.changed`, delta.changed.length, expectation.changed ?? 0, delta.changed)
    expectation.match?.([...delta.added, ...delta.removed, ...delta.changed])
  }
}

function assertBalanceDelta(
  before: WorldState,
  after: WorldState,
  expected: Record<string, number>,
): void {
  const beforeByName = new Map(before.lnbits.wallets.map(wallet => [wallet.name, wallet]))
  const afterByName = new Map(after.lnbits.wallets.map(wallet => [wallet.name, wallet]))
  const names = new Set([...beforeByName.keys(), ...afterByName.keys()])

  for (const name of names) {
    const beforeWallet = beforeByName.get(name)
    const afterWallet = afterByName.get(name)
    const deltaSats = ((afterWallet?.balanceMsat ?? 0) - (beforeWallet?.balanceMsat ?? 0)) / 1000
    if (!(name in expected)) {
      if (!beforeWallet || !afterWallet || deltaSats !== 0) {
        throw new Error(
          `Unexpected LNbits wallet change for ${name}: ${format({before: beforeWallet, after: afterWallet})}`,
        )
      }
      continue
    }
    if (deltaSats !== expected[name]) {
      throw new Error(
        `Unexpected balance delta for ${name}: expected ${expected[name]} sats, got ${deltaSats} sats`,
      )
    }
  }

  for (const name of Object.keys(expected)) {
    if (!names.has(name)) throw new Error(`Expected LNbits wallet ${name} was not found`)
  }
}

function assertPaymentDelta(
  before: WorldState,
  after: WorldState,
  expected: {out: boolean; sats: number; times: number}[],
): void {
  const beforeByKey = new Map(before.lnbits.payments.map(payment => [paymentKey(payment), payment]))
  const afterByKey = new Map(after.lnbits.payments.map(payment => [paymentKey(payment), payment]))
  const events: WorldState['lnbits']['payments'] = []

  for (const [key, payment] of afterByKey) {
    const previous = beforeByKey.get(key)
    if (!previous) events.push(payment)
    else if (!Bun.deepEquals(previous, payment)) {
      if (!previous.paid && payment.paid && samePaymentExceptPaid(previous, payment)) {
        events.push(payment)
      } else {
        throw new Error(
          `Unexpected LNbits payment change: ${format({before: previous, after: payment})}`,
        )
      }
    }
  }
  for (const [key, payment] of beforeByKey) {
    if (!afterByKey.has(key))
      throw new Error(`Unexpected removed LNbits payment: ${format(payment)}`)
  }

  const actualCounts = countPaymentEvents(events)
  const expectedCounts = new Map(
    expected.map(item => [paymentEventKey(item.out, item.sats), item.times]),
  )
  if (!Bun.deepEquals(actualCounts, expectedCounts)) {
    throw new Error(
      `Unexpected LNbits payment events: expected ${format(Object.fromEntries(expectedCounts))}, ` +
        `got ${format(Object.fromEntries(actualCounts))}; events ${format(events)}`,
    )
  }
}

function assertTelegramDelta(
  before: WorldState,
  after: WorldState,
  expected: string[] | {method: string; to?: number; text?: RegExp}[],
): void {
  const prefix = after.telegram.slice(0, before.telegram.length)
  if (!Bun.deepEquals(prefix, before.telegram)) {
    throw new Error(`Telegram history changed before the action: ${format({before, after})}`)
  }
  const calls = after.telegram.slice(before.telegram.length)
  if (expected.every(item => typeof item === 'string')) {
    const methods = calls.map(call => call.method)
    if (!Bun.deepEquals(methods, expected)) {
      throw new Error(
        `Unexpected Telegram calls: expected ${format(expected)}, got ${format(calls)}`,
      )
    }
    return
  }

  if (calls.length !== expected.length) {
    throw new Error(`Unexpected Telegram calls: expected ${format(expected)}, got ${format(calls)}`)
  }
  expected.forEach((item, index) => {
    if (typeof item === 'string') return
    const call = calls[index]
    if (!call) throw new Error(`Missing Telegram call at index ${index}: ${format(item)}`)
    if (call.method !== item.method) {
      throw new Error(`Telegram call ${index}: expected ${item.method}, got ${format(call)}`)
    }
    const to = Number(call.payload.chat_id ?? call.payload.user_id)
    if (item.to !== undefined && to !== item.to) {
      throw new Error(`Telegram call ${index}: expected recipient ${item.to}, got ${format(call)}`)
    }
    const text = String(call.payload.text ?? call.payload.caption ?? '')
    if (item.text && !item.text.test(text)) {
      throw new Error(`Telegram call ${index}: text ${format(text)} does not match ${item.text}`)
    }
  })
}

function diffRows(key: DbKey, before: unknown[], after: unknown[]) {
  const beforeById = new Map(before.map(row => [rowIdentity(key, row), row]))
  const afterById = new Map(after.map(row => [rowIdentity(key, row), row]))
  const added: RowDelta[] = []
  const removed: RowDelta[] = []
  const changed: RowDelta[] = []
  for (const [id, row] of afterById) {
    const previous = beforeById.get(id)
    if (!previous) added.push({after: row})
    else if (!Bun.deepEquals(previous, row)) changed.push({before: previous, after: row})
  }
  for (const [id, row] of beforeById) {
    if (!afterById.has(id)) removed.push({before: row})
  }
  return {added, removed, changed}
}

function rowIdentity(key: DbKey, value: unknown): string | number {
  const row = asRecord(value)
  const field =
    key === 'pendingInvoices' ? 'paymentRequest' : key === 'conversations' ? 'key' : 'id'
  const id = row[field]
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error(`Cannot identify ${key} row: ${format(value)}`)
  }
  return id
}

function countPaymentEvents(payments: WorldState['lnbits']['payments']): Map<string, number> {
  const counts = new Map<string, number>()
  for (const payment of payments) {
    const key = paymentEventKey(payment.out, payment.amountMsat / 1000)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function paymentEventKey(out: boolean, sats: number): string {
  return `${out ? 'out' : 'in'}:${sats}`
}

function paymentKey(payment: WorldState['lnbits']['payments'][number]): string {
  return `${payment.hash}:${payment.walletId}:${payment.out ? 'out' : 'in'}`
}

function samePaymentExceptPaid(
  before: WorldState['lnbits']['payments'][number],
  after: WorldState['lnbits']['payments'][number],
): boolean {
  return Bun.deepEquals({...before, paid: after.paid}, after)
}

async function selectAll(e2e: E2E, table: SQLiteTable): Promise<unknown[]> {
  return e2e.db.select().from(table)
}

function emptyDbState(): WorldState['db'] {
  return {
    users: [],
    chats: [],
    subscriptions: [],
    subscriptionIntents: [],
    subscriptionPayments: [],
    pendingInvoices: [],
    conversations: [],
    onchainChatPayments: [],
  }
}

function dbKey(tableName: string): DbKey {
  const keyByTable: Record<string, DbKey> = {
    users: 'users',
    chats: 'chats',
    subscriptions: 'subscriptions',
    subscription_intents: 'subscriptionIntents',
    subscription_payments: 'subscriptionPayments',
    pending_invoices: 'pendingInvoices',
    conversations: 'conversations',
    onchain_chat_payments: 'onchainChatPayments',
  }
  const key = keyByTable[tableName]
  if (!key) throw new Error(`World snapshot has no key for table ${tableName}`)
  return key
}

function normalizeDbRows(rows: unknown[]): unknown[] {
  return rows
    .map(row => normalizeDbValue(row))
    .sort((left, right) => format(left).localeCompare(format(right)))
}

function normalizeDbValue(value: unknown, key?: string): unknown {
  if (
    key === 'createdAt' ||
    key === 'updatedAt' ||
    key === 'expiresAt' ||
    key === 'attemptReservationExpiresAt'
  )
    return '<ts>'
  if (Array.isArray(value)) return value.map(item => normalizeDbValue(item))
  if (value instanceof Date) return new Date(value)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      normalizeDbValue(entryValue, entryKey),
    ]),
  )
}

function normalizeTelegramValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(UUID_PATTERN, '<uuid>')
  if (Array.isArray(value)) return value.map(item => normalizeTelegramValue(item))
  if (!value || typeof value !== 'object' || value instanceof File) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeTelegramValue(entryValue)]),
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a row object, got ${format(value)}`)
  }
  return value as Record<string, unknown>
}

function assertCount(label: string, actual: number, expected: number, rows: RowDelta[]): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}; rows ${format(rows)}`)
  }
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
