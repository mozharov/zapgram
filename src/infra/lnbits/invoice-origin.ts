import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {LNBitsAPI} from './lnbits-api.js'
import type {InvoiceOrigin} from './outgoing-liquidity.js'

/**
 * LNbits 1.7.1 calls the funding source only from `_pay_external_invoice`.
 * `pay_invoice` never gets there when an incoming row (`amount > 0`) is pending
 * (`check_internal`) or already successful (`is_internal_status_success`).
 * A pending or successful outgoing row on the payer's own wallet is returned
 * by `_verify_external_payment` without a new funding-source call.
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

  async paymentsForHash(paymentHash: string, bearerToken: string): Promise<unknown> {
    const response = await this.fetch(
      '/api/v1/payments/all/paginated',
      {
        retry: {limit: 0},
        searchParams: {payment_hash: paymentHash, limit: 50},
        headers: {Authorization: `Bearer ${bearerToken}`},
      },
      {logHttpError: false},
    )
    return response.body
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
      const body = await lookup.paymentsForHash(paymentHash, bearerToken)
      return originFromAdminPaymentPage(body, payerWalletId)
    } catch {
      return 'unknown'
    }
  }
}

/** Admin payment page → whether this pay can skip the funding source. */
export function originFromAdminPaymentPage(body: unknown, payerWalletId?: string): InvoiceOrigin {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown'
  const data = (body as {data?: unknown}).data
  if (!Array.isArray(data)) return 'unknown'
  let skipsFundingSource = false
  for (const row of data) {
    const parsed = paymentRow(row)
    if (!parsed) return 'unknown'
    const incomingLive =
      parsed.amount > 0 && (parsed.status === 'pending' || parsed.status === 'success')
    const ownOutgoingInFlight =
      payerWalletId !== undefined &&
      parsed.walletId === payerWalletId &&
      parsed.amount < 0 &&
      (parsed.status === 'pending' || parsed.status === 'success')
    if (incomingLive || ownOutgoingInFlight) skipsFundingSource = true
  }
  return skipsFundingSource ? 'internal' : 'external'
}

function paymentRow(
  row: unknown,
): {amount: number; status: string; walletId: string | undefined} | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return
  const record = row as Record<string, unknown>
  const {amount, status, wallet_id: walletId} = record
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return
  if (status !== 'pending' && status !== 'success' && status !== 'failed') return
  if (walletId !== undefined && typeof walletId !== 'string') return
  return {amount, status, walletId}
}
