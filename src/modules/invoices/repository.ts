import type {AppDatabase} from '@infra/db/client.js'
import {pendingInvoicesTable} from '@infra/db/schema.js'
import type {NewPendingInvoice, PendingInvoice} from '@infra/db/types.js'
import {firstOrThrow} from '@infra/db/utils.js'
import {and, count, eq, lt} from 'drizzle-orm'
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

    /**
     * Delete one pending row and return it. `undefined` means the row was already gone, so a
     * caller must not treat a stale in-memory copy as cancelled.
     */
    async deleteByPaymentRequest(paymentRequest: PendingInvoice['paymentRequest']) {
      return database
        .delete(pendingInvoicesTable)
        .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
        .returning()
        .then(rows => rows[0])
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

    async listExpired() {
      return database.query.pendingInvoicesTable.findMany({
        where: lt(pendingInvoicesTable.expiresAt, new Date()),
      })
    },

    async setWidgetMessage(
      paymentRequest: PendingInvoice['paymentRequest'],
      widgetChatId: number,
      widgetMessageId: number,
    ) {
      await database
        .update(pendingInvoicesTable)
        .set({widgetChatId, widgetMessageId})
        .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
    },

    async clearWidgetMessage(paymentRequest: PendingInvoice['paymentRequest']) {
      await database
        .update(pendingInvoicesTable)
        .set({widgetChatId: null, widgetMessageId: null})
        .where(eq(pendingInvoicesTable.paymentRequest, paymentRequest))
    },

    /**
     * Point the live widget at `toPaymentRequest` and drop it from `fromPaymentRequest`.
     *
     * bun-sqlite commits when the transaction callback returns, and it invokes that callback
     * synchronously. An `async` callback yields at the first `await`, so the commit lands before
     * the second update and the two writes are not one transaction. Both statements stay synchronous
     * (`.all()`) for that reason.
     *
     * Returns false when `fromPaymentRequest` no longer holds this message (already claimed, or the
     * pointer moved). The destination is left untouched, so a late paid status for A cannot be
     * written onto the message that now shows B. Throws, and rolls both writes back, when the
     * destination row is already gone.
     */
    async moveWidgetMessage(
      fromPaymentRequest: PendingInvoice['paymentRequest'],
      toPaymentRequest: PendingInvoice['paymentRequest'],
      widgetChatId: number,
      widgetMessageId: number,
    ): Promise<boolean> {
      return database.transaction(tx => {
        const cleared = tx
          .update(pendingInvoicesTable)
          .set({widgetChatId: null, widgetMessageId: null})
          .where(
            and(
              eq(pendingInvoicesTable.paymentRequest, fromPaymentRequest),
              eq(pendingInvoicesTable.widgetChatId, widgetChatId),
              eq(pendingInvoicesTable.widgetMessageId, widgetMessageId),
            ),
          )
          .returning()
          .all()
        if (cleared.length !== 1) return false
        const attached = tx
          .update(pendingInvoicesTable)
          .set({widgetChatId, widgetMessageId})
          .where(eq(pendingInvoicesTable.paymentRequest, toPaymentRequest))
          .returning()
          .all()
        if (attached.length !== 1) {
          throw new Error('Invoice widget destination is gone')
        }
        return true
      })
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
export const listExpiredInvoices = () => getRuntime().invoices.listExpired()
export const setInvoiceWidgetMessage = (
  paymentRequest: PendingInvoice['paymentRequest'],
  widgetChatId: number,
  widgetMessageId: number,
) => getRuntime().invoices.setWidgetMessage(paymentRequest, widgetChatId, widgetMessageId)
export const clearInvoiceWidgetMessage = (paymentRequest: PendingInvoice['paymentRequest']) =>
  getRuntime().invoices.clearWidgetMessage(paymentRequest)
export const moveInvoiceWidgetMessage = (
  fromPaymentRequest: PendingInvoice['paymentRequest'],
  toPaymentRequest: PendingInvoice['paymentRequest'],
  widgetChatId: number,
  widgetMessageId: number,
) =>
  getRuntime().invoices.moveWidgetMessage(
    fromPaymentRequest,
    toPaymentRequest,
    widgetChatId,
    widgetMessageId,
  )
