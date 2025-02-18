import type {PendingInvoice, User} from '../../lib/database/types.js'
import {logger} from '../../lib/logger.js'
import {getUserOrThrow} from '../../models/user.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {msatsToSats} from '../../utils/sats.js'
import {bot} from '../bot.js'
import {DecodedInvoice} from '../lib/decoded-invoice.js'
import {translate} from '../lib/i18n.js'
import {sanitizeMemo} from '../../helpers/memo.js'

export async function notifyInvoicePaid(
  paymentRequest: PendingInvoice['paymentRequest'],
  userId: User['id'],
) {
  const user = await getUserOrThrow(userId)
  const wallet = await getUserWallet(user.id)

  const decodedInvoice = new DecodedInvoice(paymentRequest)
  const memo = sanitizeMemo(decodedInvoice.description ?? '')
  await bot.api
    .sendMessage(
      user.id,
      translate('received-incoming-invoice', user.languageCode, {
        amount: decodedInvoice.satoshi,
        hasDescription: (!!memo).toString(),
        description: memo,
        balance: msatsToSats(wallet.balance),
      }),
    )
    .catch((error: unknown) => {
      logger.error({error}, 'Failed to send message to user about paid invoice')
    })
}
