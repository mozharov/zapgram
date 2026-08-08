import type {OnchainChatPayment} from '@infra/db/types.js'
import {translate} from '@telegram/i18n/i18n.js'
import {getRuntime} from '../../../runtime.js'

type StatusKey = 'onchain-invoice.expired' | 'onchain-invoice.grace'

/**
 * Best-effort edit of the address payment message when UI/watch windows end.
 * Co-located under telegram/ so jobs can stay free of @telegram imports.
 */
export async function editOnchainStatusMessage(
  payment: Pick<OnchainChatPayment, 'id' | 'userId' | 'telegramChatId' | 'telegramMessageId'>,
  key: StatusKey,
): Promise<void> {
  if (payment.telegramChatId == null || payment.telegramMessageId == null) return
  const {users, bot, log} = getRuntime()
  try {
    const user = await users.getOrThrow(payment.userId)
    const text = translate(key, user.languageCode)
    await bot.api.editMessageText(payment.telegramChatId, payment.telegramMessageId, text)
  } catch (error) {
    log.debug(
      {error, onchainId: payment.id, key},
      'Could not edit on-chain payment Telegram message',
    )
  }
}
