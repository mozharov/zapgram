import {config} from '@config'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {msatsToSats} from '@core/money/sats.js'
import type {PendingInvoice, User} from '@infra/db/types.js'
import {notifier} from '@modules/notifications/notifier.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {translate} from '../bot/lib/i18n.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export async function notifyInvoicePaid(
  paymentRequest: PendingInvoice['paymentRequest'],
  userId: User['id'],
) {
  const user = await getUserOrThrow(userId)
  const wallet = await getUserWallet(user.id)

  const invoice = decodeInvoice(paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '', config.memoFooter)
  await notifier.send(
    user.id,
    translate('received-incoming-invoice', user.languageCode, {
      amount: invoice.satoshi,
      hasDescription: (!!memo).toString(),
      description: memo,
      balance: msatsToSats(wallet.balance),
    }),
  )
}
