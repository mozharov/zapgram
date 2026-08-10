import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {msatsToSats} from '@core/money/sats.js'
import type {PendingInvoice, User} from '@infra/db/types.js'
import {notifier} from '@modules/notifications/notifier.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {translate} from '@telegram/i18n/i18n.js'
import {getRuntime} from '../../runtime.js'

export async function notifyInvoicePaid(
  paymentRequest: PendingInvoice['paymentRequest'],
  userId: User['id'],
) {
  const user = await getUserOrThrow(userId)
  const wallet = await getUserWallet(user.id)

  const invoice = decodeInvoice(paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '', getRuntime().config.memoFooter)
  const balance = msatsToSats(wallet.balance)
  const [usdSuffix = '', balanceUsdSuffix = ''] = await usdSuffixesForSats([
    invoice.satoshi,
    balance,
  ])
  await notifier.send(
    user.id,
    translate('received-incoming-invoice', user.languageCode, {
      amount: invoice.satoshi,
      usdSuffix,
      hasDescription: (!!memo).toString(),
      description: memo,
      balance,
      balanceUsdSuffix,
    }),
  )
}
