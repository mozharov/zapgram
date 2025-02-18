import {HTTPError} from 'got'
import {logger} from '../logger.js'
import {LNBitsAPI} from './lnbits-api.js'
import {
  paymentResponseSchema,
  feeReserveResponseSchema,
  lookupPaymentResponseSchema,
  type PaymentResponse,
} from './schemas.js'
import {InvoiceAlreadyPaidError} from '../../bot/errors/invoice-already-paid.js'
import {InsufficientFundsError} from '../../bot/errors/insufficient-funds.js'
import {buildInvoiceMemo} from '../../helpers/memo.js'

const DEFAULT_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export class UserWallet extends LNBitsAPI {
  /** Balance in millisatoshis */
  public readonly balance: number

  constructor(adminKey: string, balance: number) {
    super({adminKey})
    this.balance = balance
  }

  async createInvoice({sats, memo = '', expiry = DEFAULT_EXPIRY}: CreateInvoiceParams) {
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        out: false,
        amount: sats,
        unit: 'sat',
        expiry,
        memo: buildInvoiceMemo(memo),
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
    }).catch(handlePayInvoiceError) as Promise<PaymentResponse>
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
}

interface CreateInvoiceParams {
  sats: number
  memo?: string
  expiry?: number
}

function handlePayInvoiceError(error: unknown) {
  logger.error({error}, 'Error paying invoice')
  if (error instanceof HTTPError) {
    if (error.response.statusCode === 520) {
      const {detail, status} = error.response.body as {detail: string; status: string}
      if (status !== 'failed') throw error
      const message = detail.toLowerCase()
      if (message.includes('already paid')) throw new InvoiceAlreadyPaidError()
      if (message.includes('insufficient balance')) throw new InsufficientFundsError()
    }
  }
  throw error
}
