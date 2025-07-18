import {InsufficientFundsError} from '../bot/errors/insufficient-funds.js'
import type {User} from '../lib/database/types.js'
import {lnbitsMasterWallet} from '../lib/lnbits/master-wallet.js'
import {UserWallet} from '../lib/lnbits/user-wallet.js'
import {satsToMsats} from '../lib/utils/sats.js'

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

export async function internalTransfer(fromUserId: User['id'], toUserId: User['id'], sats: number) {
  const fromUserWallet = await getUserWallet(fromUserId)
  if (fromUserWallet.balance < satsToMsats(sats)) throw new InsufficientFundsError()
  const toUserWallet = await getUserWallet(toUserId)
  const invoice = await toUserWallet.createInvoice({sats})
  await fromUserWallet.payInvoice(invoice.bolt11)
}
