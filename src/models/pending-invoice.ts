import {db} from '../lib/database/database.js'
import {pendingInvoicesTable} from '../lib/database/schema.js'
import type {PendingInvoice, NewPendingInvoice} from '../lib/database/types.js'
import {and, count, eq, lt} from 'drizzle-orm'

export async function createPendingInvoice(data: NewPendingInvoice) {
  return db
    .insert(pendingInvoicesTable)
    .values(data)
    .returning()
    .then(res => res[0]!)
}

export async function getPendingInvoiceBy(criteria: Partial<PendingInvoice>) {
  const where = Object.entries(criteria).map(([key, value]) =>
    eq(pendingInvoicesTable[key as keyof PendingInvoice], value),
  )
  return db.query.pendingInvoicesTable.findFirst({
    where: and(...where),
  })
}

export async function deletePendingInvoice(paymentRequest: PendingInvoice['paymentRequest']) {
  await db
    .delete(pendingInvoicesTable)
    .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
}

export async function getPendingInvoices(limit?: number, offset?: number) {
  return db.query.pendingInvoicesTable.findMany({
    limit,
    offset,
  })
}

export async function countPendingInvoices() {
  return db
    .select({count: count()})
    .from(pendingInvoicesTable)
    .then(res => res[0]!.count)
}

export async function deleteExpiredInvoices() {
  return db
    .delete(pendingInvoicesTable)
    .where(lt(pendingInvoicesTable.expiresAt, new Date()))
    .returning()
    .then(res => res.length)
}
