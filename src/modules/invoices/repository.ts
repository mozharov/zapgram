import type {AppDatabase} from '@infra/db/client.js'
import {db as defaultDb} from '@infra/db/client.js'
import {pendingInvoicesTable} from '@infra/db/schema.js'
import type {NewPendingInvoice, PendingInvoice} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {count, eq, lt} from 'drizzle-orm'

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
        .then(res => res.length)
    },
  }
}

export type InvoiceRepository = ReturnType<typeof createInvoiceRepository>

/** Legacy singleton — removed in step 11. */
export const invoicesRepository = createInvoiceRepository(defaultDb)

export const createPendingInvoice = (data: NewPendingInvoice) => invoicesRepository.create(data)
/** @deprecated Prefer findByPaymentRequest. Accepts {paymentRequest} for compatibility. */
export const getPendingInvoiceBy = (criteria: {
  paymentRequest?: PendingInvoice['paymentRequest']
  paymentHash?: PendingInvoice['paymentHash']
}) => {
  if (criteria.paymentRequest)
    return invoicesRepository.findByPaymentRequest(criteria.paymentRequest)
  if (criteria.paymentHash) return invoicesRepository.findByPaymentHash(criteria.paymentHash)
  throw new Error('getPendingInvoiceBy requires paymentRequest or paymentHash')
}
export const deletePendingInvoice = (paymentRequest: PendingInvoice['paymentRequest']) =>
  invoicesRepository.deleteByPaymentRequest(paymentRequest)
export const getPendingInvoices = (limit?: number, offset?: number) =>
  invoicesRepository.list(limit, offset)
export const countPendingInvoices = () => invoicesRepository.count()
export const deleteExpiredInvoices = () => invoicesRepository.deleteExpired()
