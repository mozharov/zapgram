import {msatsToSats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {notifier} from '@modules/notifications/notifier.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {translate} from '@telegram/i18n/i18n.js'

export async function notifySatsReceived(
  toUserId: User['id'],
  sats: number,
  fromUsername?: User['username'],
): Promise<void> {
  const toUser = await getUserOrThrow(toUserId)
  const wallet = await getUserWallet(toUser.id)
  const balance = msatsToSats(wallet.balance)
  const [usdSuffix = '', balanceUsdSuffix = ''] = await usdSuffixesForSats([sats, balance])
  await notifier.send(
    toUser.id,
    translate('sats-received', toUser.languageCode, {
      amount: sats,
      usdSuffix,
      username: fromUsername ?? 'no',
      balance,
      balanceUsdSuffix,
    }),
  )
}
