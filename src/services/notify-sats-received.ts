import {msatsToSats} from '@core/money/sats.js'
import type {User} from '@infra/db/types.js'
import {logger} from '@infra/logger.js'
import {bot} from '../bot/bot.js'
import {translate} from '../bot/lib/i18n.js'
import {getUserOrThrow} from '../models/user.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export async function notifySatsReceived(
  toUserId: User['id'],
  sats: number,
  fromUsername?: User['username'],
): Promise<void> {
  const toUser = await getUserOrThrow(toUserId)
  const wallet = await getUserWallet(toUser.id)
  await bot.api
    .sendMessage(
      toUser.id,
      translate('sats-received', toUser.languageCode, {
        amount: sats,
        username: fromUsername ?? 'no',
        balance: msatsToSats(wallet.balance),
      }),
    )
    .catch((error: unknown) => {
      logger.error({error}, 'Failed to notify user about received sats')
    })
}
