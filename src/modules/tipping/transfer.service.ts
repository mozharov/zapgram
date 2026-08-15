import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {satsToMsats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {getRuntime} from '../../runtime.js'

export async function internalTransfer(fromUserId: User['id'], toUserId: User['id'], sats: number) {
  const {log} = getRuntime()
  const fromUserWallet = await getUserWallet(fromUserId)
  if (fromUserWallet.balance < satsToMsats(sats)) {
    log.info(
      {fromUserId, toUserId, sats, balanceMsats: fromUserWallet.balance},
      'Internal transfer rejected: insufficient balance',
    )
    throw new InsufficientFundsError()
  }
  const toUserWallet = await getUserWallet(toUserId)
  const invoice = await toUserWallet.createInvoice({sats})
  await fromUserWallet.payInvoice(invoice.bolt11)
  log.info(
    {fromUserId, toUserId, sats, paymentHash: invoice.payment_hash},
    'Internal transfer settled',
  )
}
