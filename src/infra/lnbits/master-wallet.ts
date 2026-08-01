import type {AppConfig} from '@config'
import {LNBitsAPI} from './lnbits-api.js'
import {
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

  constructor({
    baseUrl,
    adminKey,
    bearerToken,
    feeCollectionInvoiceKey,
  }: {
    baseUrl: string
    adminKey?: string
    bearerToken?: string
    feeCollectionInvoiceKey: string
  }) {
    super({baseUrl, adminKey})
    this.bearerToken = bearerToken
    this.feeCollectionInvoiceKey = feeCollectionInvoiceKey
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
    })
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
  })
}
