import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {GUARD_UPSTREAM_TIMEOUT_MS, LNBitsAPI} from './lnbits-api.js'
import type {InvoiceOrigin} from './outgoing-liquidity.js'

const PAGE_SIZE = 50
/** Past this many rows the list is not trusted and the pay fails open. */
const MAX_CLASSIFY_ROWS = 200

/**
 * LNbits 1.7.1 calls the funding source only from `_pay_external_invoice`.
 * `pay_invoice` never gets there when an incoming row (`amount > 0`) is pending
 * (`check_internal`) or already successful (`is_internal_status_success`).
 * LNbits 1.7.1 answers a retry of the payer's own failed or successful outgoing
 * row with HTTP 520 and does not send it to the funding source again. A pending
 * own outgoing row is returned as the old payment, also without a second send.
 * The guard must not replace that refusal with a pause.
 * Anything else, including another wallet's outgoing row, still pays externally.
 *
 * `GET /api/v1/payments/all/paginated` with the admin access token lists every
 * wallet's rows for the hash and does not run `update_pending_payment`, so the
 * lookup cannot expire a pending invoice before pay. The keyless
 * `GET /api/v1/payments/{hash}` cannot be used: it returns whichever row sorts
 * first and treats any existing row as 200.
 */
class OriginLookup extends LNBitsAPI {
  constructor(baseUrl: string) {
    super({baseUrl})
  }

  async page(bearerToken: string, searchParams: Record<string, string | number>): Promise<unknown> {
    const response = await this.fetch(
      '/api/v1/payments/all/paginated',
      {
        retry: {limit: 0},
        timeout: {request: GUARD_UPSTREAM_TIMEOUT_MS},
        searchParams,
        headers: {Authorization: `Bearer ${bearerToken}`},
      },
      {logHttpError: false},
    )
    return response.body
  }
}

/**
 * One admin-list read that asks for a hash nothing should have.
 * False when the page is unreadable or a row comes back for a different hash,
 * which means the server ignored `payment_hash`.
 */
export async function probeAdminPaymentList(
  baseUrl: string,
  bearerToken: string | undefined,
): Promise<boolean> {
  if (!bearerToken) return false
  const lookup = new OriginLookup(baseUrl)
  const probeHash = '00'.repeat(32)
  try {
    const page = readPaymentPage(
      await lookup.page(bearerToken, {payment_hash: probeHash, limit: 1}),
    )
    if (!page) return false
    return page.data.every(row => paymentRow(row)?.paymentHash.toLowerCase() === probeHash)
  } catch {
    return false
  }
}

export function createInvoiceOriginLookup(
  baseUrl: string,
  bearerToken?: string,
): (bolt11: string, payerWalletId?: string) => Promise<InvoiceOrigin> {
  const lookup = new OriginLookup(baseUrl)
  return async (bolt11, payerWalletId) => {
    if (!bearerToken) return 'unknown'
    let paymentHash: string
    try {
      paymentHash = decodeInvoice(bolt11).paymentHash
    } catch {
      return 'unknown'
    }
    if (!paymentHash) return 'unknown'
    try {
      const rows = await loadPaymentRows(lookup, bearerToken, paymentHash)
      if (!rows) return 'unknown'
      return originFromAdminPaymentPage(
        {data: rows, total: rows.length},
        paymentHash,
        payerWalletId,
      )
    } catch {
      return 'unknown'
    }
  }
}

async function loadPaymentRows(
  lookup: OriginLookup,
  bearerToken: string,
  paymentHash: string,
): Promise<unknown[] | undefined> {
  const rows: unknown[] = []
  let fetched = 0
  for (let page = 0; page < MAX_CLASSIFY_ROWS / PAGE_SIZE; page++) {
    const parsed = readPaymentPage(
      await lookup.page(bearerToken, {
        payment_hash: paymentHash,
        limit: PAGE_SIZE,
        offset: fetched,
      }),
    )
    if (!parsed) return
    if (parsed.total > MAX_CLASSIFY_ROWS) return
    if (parsed.data.length === 0) return fetched >= parsed.total ? rows : undefined
    rows.push(...parsed.data)
    fetched += parsed.data.length
    if (fetched >= parsed.total) return rows
  }
  return
}

function readPaymentPage(body: unknown): {data: unknown[]; total: number} | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const record = body as {data?: unknown; total?: unknown}
  if (!Array.isArray(record.data)) return
  if (typeof record.total !== 'number' || !Number.isSafeInteger(record.total) || record.total < 0) {
    return
  }
  return {data: record.data, total: record.total}
}

/**
 * Admin payment page → whether this pay can skip the funding source.
 * A row whose `payment_hash` is not the one we asked for means the server filter
 * was not applied. That page must not be treated as internal.
 */
export function originFromAdminPaymentPage(
  body: unknown,
  paymentHash: string,
  payerWalletId?: string,
): InvoiceOrigin {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown'
  const data = (body as {data?: unknown}).data
  if (!Array.isArray(data)) return 'unknown'
  const wanted = paymentHash.toLowerCase()
  let skipsFundingSource = false
  for (const row of data) {
    const parsed = paymentRow(row)
    if (!parsed) return 'unknown'
    if (parsed.paymentHash.toLowerCase() !== wanted) return 'unknown'
    const incomingLive =
      parsed.amount > 0 && (parsed.status === 'pending' || parsed.status === 'success')
    const ownOutgoingSkipsFundingSource =
      payerWalletId !== undefined &&
      parsed.walletId === payerWalletId &&
      parsed.amount < 0 &&
      (parsed.status === 'pending' || parsed.status === 'success' || parsed.status === 'failed')
    if (incomingLive || ownOutgoingSkipsFundingSource) skipsFundingSource = true
  }
  return skipsFundingSource ? 'internal' : 'external'
}

function paymentRow(row: unknown):
  | {
      amount: number
      status: string
      walletId: string | undefined
      paymentHash: string
    }
  | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return
  const record = row as Record<string, unknown>
  const {amount, status, wallet_id: walletId, payment_hash: paymentHash} = record
  if (typeof paymentHash !== 'string' || paymentHash.length === 0) return
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return
  if (status !== 'pending' && status !== 'success' && status !== 'failed') return
  if (walletId !== undefined && typeof walletId !== 'string') return
  return {amount, status, walletId, paymentHash}
}
