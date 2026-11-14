import type {AppConfig} from '@config'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {HTTPError} from 'got'
import {LNBitsAPI} from './lnbits-api.js'
import type {
  BalanceRead,
  LiquidityCheckReason,
  OutgoingLiquidityGuard,
} from './outgoing-liquidity.js'
import {
  feeReserveResponseSchema,
  healthResponseSchema,
  lookupPaymentResponseSchema,
  paymentResponseSchema,
  userResponseSchema,
  usersResponseSchema,
  walletResponseSchema,
} from './schemas.js'

class MasterWallet extends LNBitsAPI {
  private readonly bearerToken?: string
  private readonly feeCollectionInvoiceKey: string
  private readonly paymentWebhookUrl?: string
  private outgoingLiquidity?: OutgoingLiquidityGuard

  constructor({
    baseUrl,
    adminKey,
    bearerToken,
    feeCollectionInvoiceKey,
    paymentWebhookUrl,
  }: {
    baseUrl: string
    adminKey?: string
    bearerToken?: string
    feeCollectionInvoiceKey: string
    paymentWebhookUrl?: string
  }) {
    super({baseUrl, adminKey})
    this.bearerToken = bearerToken
    this.feeCollectionInvoiceKey = feeCollectionInvoiceKey
    this.paymentWebhookUrl = paymentWebhookUrl
  }

  private getAuthHeaders() {
    if (!this.bearerToken) return {}
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      // Remove X-API-KEY for OAuth endpoints
      'X-API-KEY': undefined,
    }
  }

  async createUser(username: string) {
    return this.fetchWithSchema('/users/api/v1/user', userResponseSchema, {
      method: 'POST',
      body: JSON.stringify({username}),
      headers: this.getAuthHeaders(),
    })
  }

  async getWallet(userId: string) {
    return this.fetchWithSchema(`/users/api/v1/user/${userId}/wallet`, walletResponseSchema, {
      headers: this.getAuthHeaders(),
    }).then(wallets => {
      const wallet = wallets[0]
      if (wallet === undefined) throw new Error('LNbits wallet not found for user')
      return wallet
    })
  }

  async getUserByUsername(username: string) {
    return this.fetchWithSchema(`/users/api/v1/user`, usersResponseSchema, {
      searchParams: {username},
      headers: this.getAuthHeaders(),
    }).then(users => users.data[0])
  }

  async checkStatus() {
    return this.fetchWithSchema('/api/v1/health', healthResponseSchema)
  }

  /**
   * @param expiry - number of seconds until the invoice expires
   */
  async createInvoice(sats: number, expiry: number) {
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        out: false,
        amount: sats,
        unit: 'sat',
        expiry,
        ...(this.paymentWebhookUrl ? {webhook: this.paymentWebhookUrl} : {}),
      }),
    }).catch((error: unknown) => {
      throw new InvoiceGenerationError({cause: error})
    })
  }

  useOutgoingLiquidity(guard: OutgoingLiquidityGuard): void {
    this.outgoingLiquidity = guard
  }

  /**
   * Funding-source balance via GET /api/v1/status.
   *
   * LNbits 1.5.6, 1.7.0, and 1.7.1 share this handler. It authenticates with an access
   * token, not a wallet admin key. `funding_source_balance_msat` is added only when that
   * token's user is the superuser or in `lnbits_admin_users`. The users-API bearer is that
   * token when it is set. A missing or non-numeric balance, a non-empty
   * `funding_source_error`, or any HTTP failure is an unreadable check — never a pause.
   * The error text is dropped; an NWC failure can contain the connection URL.
   */
  async readFundingSource(): Promise<BalanceRead> {
    try {
      const response = await this.fetch(
        '/api/v1/status',
        // Fail fast. got retries GET 500s, which would delay a send that should proceed.
        {headers: this.statusHeaders(), retry: {limit: 0}},
        {logHttpError: false},
      )
      return interpretFundingSourceStatus(response.body)
    } catch (error) {
      return {ok: false, reason: statusFailureReason(error)}
    }
  }

  /** Bearer for /api/v1/status. The wallet admin key is not an access token, so it is not sent. */
  private statusHeaders(): Record<string, string | undefined> {
    if (!this.bearerToken) return {'X-Api-Key': undefined}
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      'X-Api-Key': undefined,
    }
  }

  async payInvoice(paymentRequest: string) {
    if (this.outgoingLiquidity) {
      await this.outgoingLiquidity.assertCanPay({
        bolt11: paymentRequest,
        feeReserveMsat: () => this.feeReserveMsat(paymentRequest),
      })
    }
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({
        out: true,
        bolt11: paymentRequest,
      }),
    })
  }

  private async feeReserveMsat(paymentRequest: string): Promise<number> {
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

  async createFeeCollectionInvoice(sats: number) {
    return this.fetchWithSchema('/api/v1/payments', paymentResponseSchema, {
      method: 'POST',
      body: JSON.stringify({out: false, amount: sats, unit: 'sat'}),
      headers: {
        'X-Api-Key': this.feeCollectionInvoiceKey,
      },
    })
  }
}

export type MasterWalletInstance = MasterWallet

function statusFailureReason(error: unknown): LiquidityCheckReason {
  if (error instanceof HTTPError) {
    const status = error.response.statusCode
    if (status === 401 || status === 403) return 'unauthorized'
    if (status === 404) return 'not_found'
    return 'http_error'
  }
  if (isTimeout(error)) return 'timeout'
  return 'http_error'
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  return code === 'ETIMEDOUT' || code === 'ECONNABORTED' || error.name === 'TimeoutError'
}

/** Success is only a safe integer balance and no funding-source error string. */
export function interpretFundingSourceStatus(body: unknown): BalanceRead {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, reason: 'invalid_response'}
  }
  const record = body as Record<string, unknown>
  const error = record.funding_source_error
  if (typeof error === 'string' && error.length > 0) {
    return {ok: false, reason: 'funding_source_error'}
  }
  const balance = record.funding_source_balance_msat
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
    return {ok: false, reason: 'balance_missing'}
  }
  return {ok: true, balanceMsat: balance}
}

export function createMasterWallet(cfg: AppConfig): MasterWallet {
  return new MasterWallet({
    baseUrl: cfg.LNBITS_URL,
    adminKey: cfg.LNBITS_ADMIN_KEY,
    bearerToken: cfg.LNBITS_BEARER_TOKEN,
    feeCollectionInvoiceKey: cfg.LNBITS_FEE_COLLECTION_INVOICE_KEY,
    paymentWebhookUrl: buildLnbitsPaymentWebhookUrl(cfg.HOST, cfg.BOT_WEBHOOK_SECRET),
  })
}
