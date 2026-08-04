import type {AppDatabase} from '@infra/db/client.js'
import {pendingInvoicesTable} from '@infra/db/schema.js'
import type {NewPendingInvoice, PendingInvoice} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {count, eq, lt} from 'drizzle-orm'
import {getRuntime} from '../../runtime.js'

export function createInvoiceRepository(database: AppDatabase) {
  return {
    async create(data: NewPendingInvoice) {
      return database
        .insert(pendingInvoicesTable)
        .values(data)
        .returning()
        .then(rows => firstOrThrow(rows, 'pending invoice'))
    },

    async findByPaymentRequest(paymentRequest: PendingInvoice['paymentRequest']) {
      return database.query.pendingInvoicesTable.findFirst({
        where: eq(pendingInvoicesTable.paymentRequest, paymentRequest),
      })
    },

    async findByPaymentHash(paymentHash: PendingInvoice['paymentHash']) {
      return database.query.pendingInvoicesTable.findFirst({
        where: eq(pendingInvoicesTable.paymentHash, paymentHash),
      })
    },

    async deleteByPaymentRequest(paymentRequest: PendingInvoice['paymentRequest']) {
      await database
        .delete(pendingInvoicesTable)
        .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
    },

    /**
     * Atomically claim a pending invoice for notification. Only one of webhook / internal pay /
     * cron wins the row; the rest get `undefined` and must not notify again.
     */
    async claimByPaymentRequest(paymentRequest: PendingInvoice['paymentRequest']) {
      return database
        .delete(pendingInvoicesTable)
        .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
        .returning()
        .then(rows => rows[0])
    },

    async claimByPaymentHash(paymentHash: PendingInvoice['paymentHash']) {
      return database
        .delete(pendingInvoicesTable)
        .where(eq(pendingInvoicesTable.paymentHash, paymentHash))
        .returning()
        .then(rows => rows[0])
    },

    async list(limit?: number, offset?: number) {
      return database.query.pendingInvoicesTable.findMany({
        limit,
        offset,
      })
    },

    async count() {
      return database
        .select({count: count()})
        .from(pendingInvoicesTable)
        .then(res => res[0]?.count ?? 0)
    },

    async deleteExpired() {
      return database
        .delete(pendingInvoicesTable)
        .where(lt(pendingInvoicesTable.expiresAt, new Date()))
        .returning()
    },
  }
}

export type InvoiceRepository = ReturnType<typeof createInvoiceRepository>

export const createPendingInvoice = (data: NewPendingInvoice) => getRuntime().invoices.create(data)
export const getPendingInvoiceBy = (criteria: {
  paymentRequest?: PendingInvoice['paymentRequest']
  paymentHash?: PendingInvoice['paymentHash']
}) => {
  if (criteria.paymentRequest)
    return getRuntime().invoices.findByPaymentRequest(criteria.paymentRequest)
  if (criteria.paymentHash) return getRuntime().invoices.findByPaymentHash(criteria.paymentHash)
  throw new Error('getPendingInvoiceBy requires paymentRequest or paymentHash')
}
export const deletePendingInvoice = (paymentRequest: PendingInvoice['paymentRequest']) =>
  getRuntime().invoices.deleteByPaymentRequest(paymentRequest)
export const claimPendingInvoiceByPaymentRequest = (
  paymentRequest: PendingInvoice['paymentRequest'],
) => getRuntime().invoices.claimByPaymentRequest(paymentRequest)
export const claimPendingInvoiceByPaymentHash = (paymentHash: PendingInvoice['paymentHash']) =>
  getRuntime().invoices.claimByPaymentHash(paymentHash)
export const getPendingInvoices = (limit?: number, offset?: number) =>
  getRuntime().invoices.list(limit, offset)
export const countPendingInvoices = () => getRuntime().invoices.count()
export const deleteExpiredInvoices = () => getRuntime().invoices.deleteExpired()
