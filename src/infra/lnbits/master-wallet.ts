import type {AppConfig} from '@config'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {HTTPError} from 'got'
import {LNBitsAPI} from './lnbits-api.js'
import {FundingSourceUnreadableError, type OutgoingLiquidityGuard} from './outgoing-liquidity.js'
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
   * LNbits 1.5.6 and 1.7.0 authenticate this route with an access token, not the wallet
   * admin key. `funding_source_balance_msat` is present only when that token's user is the
   * superuser or in `lnbits_admin_users`. The users API bearer is that token when it is set.
   * A wallet key, a missing bearer, or a non-admin token cannot see the field: that throws
   * {@link FundingSourceUnreadableError} so payments are not paused forever. A transport
   * failure or `funding_source_error` stays a failed read. The error text is dropped; an NWC
   * failure can contain the connection URL.
   */
  async readFundingSourceBalanceMsat(): Promise<number> {
    let response: {body: unknown}
    try {
      response = await this.fetch(
        '/api/v1/status',
        // Fail fast. got retries GET 500s, and a dead funding source should pause the send
        // instead of waiting out those retries before refusing.
        {headers: this.statusHeaders(), retry: {limit: 0}},
        {logHttpError: false},
      )
    } catch (error) {
      if (error instanceof HTTPError && isStatusHidden(error.response.statusCode)) {
        throw new FundingSourceUnreadableError()
      }
      throw new Error('Funding source balance unavailable')
    }
    const parsed = fundingSourceStatusSchema.safeParse(response.body)
    if (!parsed.success) {
      if (isNonAdminStatus(response.body)) throw new FundingSourceUnreadableError()
      throw new Error('Funding source balance unavailable')
    }
    if (parsed.data.funding_source_error) throw new Error('Funding source balance unavailable')
    const balance = parsed.data.funding_source_balance_msat
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new Error('Funding source balance unavailable')
    }
    return balance
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

function isStatusHidden(status: number): boolean {
  return status === 401 || status === 403
}

/** LNbits omits the funding-source fields for any account that is not an admin. */
function isNonAdminStatus(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return 'server_time' in body && !('funding_source_balance_msat' in body)
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
