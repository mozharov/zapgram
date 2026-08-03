import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {buildInvoiceMemo} from '@core/lightning/memo.js'
import {HTTPError} from 'got'
import type {AppLogger} from '../logger.js'
import {LNBitsAPI} from './lnbits-api.js'
import {
  balanceResponseSchema,
  feeReserveResponseSchema,
  lookupPaymentResponseSchema,
  type PaymentResponse,
  paymentResponseSchema,
} from './schemas.js'

const DEFAULT_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export class UserWallet extends LNBitsAPI {
  /** Balance in millisatoshis */
  public readonly balance: number
  private readonly memoFooter: string

  constructor(
    adminKey: string,
    balance: number,
    baseUrl: string,
    memoFooter = '',
    log?: AppLogger,
  ) {
    super({baseUrl, adminKey, log})
    this.balance = balance
    this.memoFooter = memoFooter
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
      }),
    })
  }

  async payInvoice(paymentRequest: string) {
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        out: true,
        bolt11: paymentRequest,
      }),
    }).catch(error => handlePayInvoiceError(error, this.log)) as Promise<PaymentResponse>
  }

  /**
   * @returns millisatoshis
   */
  async getFeeReserve(paymentRequest: string) {
    const response = await this.fetchWithSchema(
      '/api/v1/payments/fee-reserve',
      feeReserveResponseSchema,
      {searchParams: {invoice: paymentRequest}},
    )
    return response.fee_reserve
  }

  async lookupPayment(paymentHash: string) {
    return this.fetchWithSchema(`/api/v1/payments/${paymentHash}`, lookupPaymentResponseSchema)
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

function handlePayInvoiceError(error: unknown, log?: AppLogger) {
  log?.error({error}, 'Error paying invoice')
  if (error instanceof HTTPError) {
    if (error.response.statusCode === 520) {
      const {detail, status} = error.response.body as {detail: string; status: string}
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
