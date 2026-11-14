import {msatsToSats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {notifier, type SendOutcome} from '@modules/notifications/notifier.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {translate} from '@telegram/i18n/i18n.js'

export async function notifySatsReceived(
  toUserId: User['id'],
  sats: number,
  fromUsername?: User['username'],
): Promise<boolean> {
  const outcome = await notifySatsReceivedOutcome(toUserId, sats, fromUsername)
  return outcome === true
}

/** `unreachable` is a Telegram 403. Callers must not retry that notice. */
export async function notifySatsReceivedOutcome(
  toUserId: User['id'],
  sats: number,
  fromUsername?: User['username'],
): Promise<true | false | 'unreachable'> {
  const toUser = await getUserOrThrow(toUserId)
  const wallet = await getUserWallet(toUser.id)
  const balance = msatsToSats(wallet.balance)
  const [usdSuffix = '', balanceUsdSuffix = ''] = await usdSuffixesForSats([sats, balance])
  const outcome: SendOutcome = await notifier.sendOutcome(
    toUser.id,
    translate('sats-received', toUser.languageCode, {
      amount: sats,
      usdSuffix,
      username: fromUsername ?? 'no',
      balance,
      balanceUsdSuffix,
    }),
  )
  if (outcome === 'unreachable') return 'unreachable'
  return outcome === 'sent'
}
