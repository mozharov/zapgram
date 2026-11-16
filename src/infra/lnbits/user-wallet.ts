import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {buildInvoiceMemo} from '@core/lightning/memo.js'
import {HTTPError} from 'got'
import type {AppLogger} from '../logger.js'
import {GUARD_UPSTREAM_TIMEOUT_MS, LNBitsAPI} from './lnbits-api.js'
import {
  type LiquidityHold,
  type OutgoingLiquidityGuard,
  payAlreadyPaid,
  payLeftBackendUnspent,
} from './outgoing-liquidity.js'
import {
  balanceResponseSchema,
  feeReserveResponseSchema,
  lookupPaymentResponseSchema,
  paymentResponseSchema,
} from './schemas.js'

const DEFAULT_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export class UserWallet extends LNBitsAPI {
  /** Balance in millisatoshis */
  public readonly balance: number
  private readonly memoFooter: string
  private readonly paymentWebhookUrl?: string
  private readonly outgoingLiquidity?: OutgoingLiquidityGuard
  /** LNbits wallet id from the factory. Not fetched again: a failed read must not drop it. */
  private readonly payerWalletId?: string

  constructor(
    adminKey: string,
    balance: number,
    baseUrl: string,
    memoFooter = '',
    log?: AppLogger,
    paymentWebhookUrl?: string,
    outgoingLiquidity?: OutgoingLiquidityGuard,
    walletId?: string,
  ) {
    super({baseUrl, adminKey, log})
    this.balance = balance
    this.memoFooter = memoFooter
    this.paymentWebhookUrl = paymentWebhookUrl
    this.outgoingLiquidity = outgoingLiquidity
    this.payerWalletId = walletId
  }

  /**
   * @param expiry - number of seconds until the invoice expires
   */
  async createInvoice({sats, memo = '', expiry = DEFAULT_EXPIRY}: CreateInvoiceParams) {
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        out: false,
        amount: sats,
        unit: 'sat',
        expiry,
        memo: buildInvoiceMemo(memo, this.memoFooter),
        ...(this.paymentWebhookUrl ? {webhook: this.paymentWebhookUrl} : {}),
      }),
    }).catch((error: unknown) => {
      this.log?.error({error}, 'Error creating invoice')
      throw new InvoiceGenerationError({cause: error})
    })
  }

  async payInvoice(paymentRequest: string, options?: {knownInternal?: boolean}) {
    const hold = this.outgoingLiquidity
      ? await this.outgoingLiquidity.assertCanPay({
          bolt11: paymentRequest,
          payerWalletId: this.payerWalletId,
          knownInternal: options?.knownInternal,
          feeReserveMsat: () => this.feeReserveForPause(paymentRequest),
        })
      : undefined
    try {
      const payment = await this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          out: true,
          bolt11: paymentRequest,
        }),
      }).catch(error => handlePayInvoiceError(error, this.log))
      if (payment.status !== 'success') throw new PaymentPendingError()
      if (hold) await this.outgoingLiquidity?.settle(hold)
      return payment
    } catch (error) {
      if (hold) await this.finishHold(hold, error)
      throw error
    }
  }

  private async finishHold(hold: LiquidityHold, error: unknown): Promise<void> {
    if (payAlreadyPaid(error)) {
      await this.outgoingLiquidity?.invalidate(hold)
      return
    }
    if (payLeftBackendUnspent(error)) {
      await this.outgoingLiquidity?.release(hold)
      return
    }
    await this.outgoingLiquidity?.abandon(hold)
  }

  /**
   * @returns millisatoshis
   */
  async getFeeReserve(paymentRequest: string) {
    return this.quoteFeeReserve(paymentRequest)
  }

  /** Pause quote only. The review screen keeps the ordinary client timeout. */
  private feeReserveForPause(paymentRequest: string) {
    return this.quoteFeeReserve(
      paymentRequest,
      {
        retry: {limit: 0},
        timeout: {request: GUARD_UPSTREAM_TIMEOUT_MS},
      },
      {logHttpError: false},
    )
  }

  private async quoteFeeReserve(
    paymentRequest: string,
    init?: {retry: {limit: number}; timeout: {request: number}},
    options?: {logHttpError?: boolean},
  ) {
    const response = await this.fetchWithSchema(
      '/api/v1/payments/fee-reserve',
      feeReserveResponseSchema,
      {searchParams: {invoice: paymentRequest}, ...init},
      options,
    )
    return response.fee_reserve
  }

  async lookupPayment(paymentHash: string, options?: {quietStatuses?: number[]}) {
    return this.fetchWithSchema(
      `/api/v1/payments/${paymentHash}`,
      lookupPaymentResponseSchema,
      undefined,
      options,
    )
  }

  /**
   * @returns millisatoshis
   */
  async getBalance() {
    return this.fetchWithSchema('/api/v1/wallet', balanceResponseSchema).then(data => data.balance)
  }
}

interface CreateInvoiceParams {
  sats: number
  memo?: string
  expiry?: number
}

function handlePayInvoiceError(error: unknown, log?: AppLogger): never {
  log?.error(safePayError(error), 'Error paying invoice')
  if (error instanceof HTTPError) {
    if (error.response.statusCode === 520) {
      const {detail, status} = error.response.body as {detail: string; status: string}
      if (status === 'pending') throw new PaymentPendingError()
      if (status !== 'failed') throw error
      const message = detail.toLowerCase()
      if (message.includes('already paid')) throw new InvoiceAlreadyPaidError()
      if (
        message.includes('insufficient balance') ||
        message.includes('you must reserve at least')
      ) {
        throw new InsufficientFundsError()
      }
    }
  }
  throw error
}

function safePayError(error: unknown): {message: string; code?: string; statusCode?: number} {
  if (error instanceof HTTPError) {
    return {message: error.message, code: error.code, statusCode: error.response.statusCode}
  }
  if (error instanceof Error) {
    const code = 'code' in error && error.code != null ? String(error.code) : undefined
    return {message: error.message, code}
  }
  return {message: 'unknown'}
}
