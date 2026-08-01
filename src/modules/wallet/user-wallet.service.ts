import type {User} from '@infra/db/types.js'
import type {MasterWalletInstance} from '@infra/lnbits/master-wallet.js'
import {UserWallet} from '@infra/lnbits/user-wallet.js'
import type {AppLogger} from '@infra/logger.js'
import {getRuntime} from '../../runtime.js'

export function createUserWalletFactory(deps: {
  masterWallet: MasterWalletInstance
  baseUrl: string
  memoFooter: string
  log?: AppLogger
}) {
  return async function getUserWallet(userId: User['id']) {
    const user =
      (await deps.masterWallet.getUserByUsername(userId.toString())) ||
      (await deps.masterWallet.createUser(userId.toString()))

    if (!user.id) {
      throw new Error('User ID is missing from LNbits response')
    }

    const wallet = await deps.masterWallet.getWallet(user.id)
    return new UserWallet(
      wallet.adminkey,
      wallet.balance_msat ?? 0,
      deps.baseUrl,
      deps.memoFooter,
      deps.log,
    )
  }
}

/** Leaf-handler convenience — uses the bootstrap runtime. */
export async function getUserWallet(userId: User['id']) {
  return getRuntime().getUserWallet(userId)
}
