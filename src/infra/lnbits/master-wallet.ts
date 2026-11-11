import type {AppConfig} from '@config'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {LNBitsAPI} from './lnbits-api.js'
import type {OutgoingLiquidityGuard} from './outgoing-liquidity.js'
import {
  feeReserveResponseSchema,
  fundingSourceStatusSchema,
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
   * LNbits 1.5.6 and 1.7.0 share this route. The balance is included only for an admin
   * account — the same bearer the users API already requires — and comes from
   * funding_source.status(), which for an NWC backend is get_balance. Node APIs are not
   * used: NWC does not implement them. A missing balance or funding_source_error is a failed
   * read. The error text is dropped; an NWC failure can contain the connection URL.
   */
  async readFundingSourceBalanceMsat(): Promise<number> {
    const response = await this.fetch(
      '/api/v1/status',
      // Fail fast. got retries GET 500s, and a dead funding source should pause the send
      // instead of waiting out those retries before refusing.
      {headers: this.getAuthHeaders(), retry: {limit: 0}},
      {logHttpError: false},
    )
    const parsed = fundingSourceStatusSchema.safeParse(response.body)
    if (!parsed.success || parsed.data.funding_source_error) {
      throw new Error('Funding source balance unavailable')
    }
    return parsed.data.funding_source_balance_msat
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

export function createMasterWallet(cfg: AppConfig): MasterWallet {
  return new MasterWallet({
    baseUrl: cfg.LNBITS_URL,
    adminKey: cfg.LNBITS_ADMIN_KEY,
    bearerToken: cfg.LNBITS_BEARER_TOKEN,
    feeCollectionInvoiceKey: cfg.LNBITS_FEE_COLLECTION_INVOICE_KEY,
    paymentWebhookUrl: buildLnbitsPaymentWebhookUrl(cfg.HOST, cfg.BOT_WEBHOOK_SECRET),
  })
}
