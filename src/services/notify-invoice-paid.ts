import {config} from '@config'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {msatsToSats} from '@core/money/sats.js'
import type {PendingInvoice, User} from '@infra/db/types.js'
import {logger} from '@infra/logger.js'
import {bot} from '../bot/bot.js'
import {translate} from '../bot/lib/i18n.js'
import {getUserOrThrow} from '../models/user.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export async function notifyInvoicePaid(
  paymentRequest: PendingInvoice['paymentRequest'],
  userId: User['id'],
) {
  const user = await getUserOrThrow(userId)
  const wallet = await getUserWallet(user.id)

  const invoice = decodeInvoice(paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '', config.memoFooter)
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
