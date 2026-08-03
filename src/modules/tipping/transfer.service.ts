import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {satsToMsats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'

export async function internalTransfer(fromUserId: User['id'], toUserId: User['id'], sats: number) {
  const fromUserWallet = await getUserWallet(fromUserId)
  if (fromUserWallet.balance < satsToMsats(sats)) throw new InsufficientFundsError()
  const toUserWallet = await getUserWallet(toUserId)
  const invoice = await toUserWallet.createInvoice({sats})
  await fromUserWallet.payInvoice(invoice.bolt11)
}
