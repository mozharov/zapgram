import {config} from '../config.js'
import type {User} from '../lib/database/types.js'
import {lnbitsMasterWallet} from '../lib/lnbits/master-wallet.js'
import {getUserOrThrow} from '../models/user.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export async function distributeSubscriptionPayment(sats: number, chatOwnerId: User['id']) {
  const owner = await getUserOrThrow(chatOwnerId)
  const ownerWallet = await getUserWallet(owner.id)
  const fee = Math.ceil(sats * config.SUBSCRIPTION_FEE_PERCENT)
  const invoice = await ownerWallet.createInvoice({sats: sats - fee})
  await lnbitsMasterWallet.payInvoice(invoice.bolt11)

  if (fee > 0) {
    const feeInvoice = await lnbitsMasterWallet.createFeeCollectionInvoice(fee)
    await lnbitsMasterWallet.payInvoice(feeInvoice.bolt11)
  }
}
