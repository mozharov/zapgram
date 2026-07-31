import {bot} from '../bot/bot.js'
import {translate} from '../bot/lib/i18n.js'
import {sanitizeMemo} from '../helpers/memo.js'
import type {PendingInvoice, User} from '../lib/database/types.js'
import {decodeInvoice} from '../lib/decoded-invoice.js'
import {logger} from '../lib/logger.js'
import {msatsToSats} from '../lib/utils/sats.js'
import {getUserOrThrow} from '../models/user.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export async function notifyInvoicePaid(
  paymentRequest: PendingInvoice['paymentRequest'],
  userId: User['id'],
) {
  const user = await getUserOrThrow(userId)
  const wallet = await getUserWallet(user.id)

  const invoice = decodeInvoice(paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '')
  await bot.api
    .sendMessage(
      user.id,
      translate('received-incoming-invoice', user.languageCode, {
        amount: invoice.satoshi,
        hasDescription: (!!memo).toString(),
        description: memo,
        balance: msatsToSats(wallet.balance),
      }),
    )
    .catch((error: unknown) => {
      logger.error({error}, 'Failed to send message to user about paid invoice')
    })
}
