import {config} from '../../config.js'
import {LNBitsAPI} from './lnbits-api.js'
import {
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
}

export const lnbitsMasterWallet = new MasterWallet({adminKey: config.LNBITS_ADMIN_KEY})
