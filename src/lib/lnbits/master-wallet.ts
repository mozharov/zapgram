import {config} from '../../config.js'
import {LNBitsAPI} from './lnbits-api.js'
import {
  lookupPaymentResponseSchema,
  paymentResponseSchema,
  statusResponseSchema,
  userResponseSchema,
  usersResponseSchema,
  walletResponseSchema,
} from './schemas.js'

class MasterWallet extends LNBitsAPI {
  private readonly adminId = config.LNBITS_ADMIN_ID

  async createUser(username: string) {
    return this.fetchWithSchema('/users/api/v1/user', userResponseSchema, {
      method: 'POST',
      body: JSON.stringify({username}),
      searchParams: {usr: this.adminId},
    })
  }

  async getWallet(userId: string) {
    return this.fetchWithSchema(`/users/api/v1/user/${userId}/wallet`, walletResponseSchema, {
      searchParams: {usr: this.adminId},
    }).then(wallets => wallets[0]!)
  }

  async getUserByUsername(username: string) {
    return this.fetchWithSchema(`/users/api/v1/user`, usersResponseSchema, {
      searchParams: {username, usr: this.adminId},
    }).then(users => users.data[0])
  }

  async checkStatus() {
    return this.fetchWithSchema('/api/v1/status', statusResponseSchema)
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
        'X-Api-Key': config.LNBITS_FEE_COLLECTION_INVOICE_KEY,
      },
    })
  }
}

export const lnbitsMasterWallet = new MasterWallet({adminKey: config.LNBITS_ADMIN_KEY})
