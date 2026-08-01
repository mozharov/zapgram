import type {User} from '@infra/db/types.js'
import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {UserWallet} from '@infra/lnbits/user-wallet.js'

export async function getUserWallet(userId: User['id']) {
  const user =
    (await lnbitsMasterWallet.getUserByUsername(userId.toString())) ||
    (await lnbitsMasterWallet.createUser(userId.toString()))

  if (!user.id) {
    throw new Error('User ID is missing from LNbits response')
  }

  const wallet = await lnbitsMasterWallet.getWallet(user.id)
  return new UserWallet(wallet.adminkey, wallet.balance_msat ?? 0)
}
