import {config} from '@config'
import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {bot} from '@infra/telegram/bot.js'
import {getChatOrThrow} from '@modules/chats/repository.js'
import {notifier} from '@modules/notifications/notifier.js'
import {grantSubscriptionAccess} from '@modules/subscriptions/access.js'
import {
  deleteSubscriptionPayment,
  recordFeePayoutInvoice,
  recordPayoutInvoice,
  recordSettleAttempt,
} from '@modules/subscriptions/payment-repository.js'
import {getSubscriptionByUserAndChat} from '@modules/subscriptions/repository.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {translate} from '../../bot/lib/i18n.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {
  type CompleteSubscriptionPaymentResult,
  createSettleService,
  type DistributeOnceResult,
} from './settle.service.js'

/**
 * Default settle service wired to production singletons.
 * Removed when bootstrap owns composition (step 11).
 */
export const settleService = createSettleService({
  recordSettleAttempt,
  grantAccess: grantSubscriptionAccess,
  approveChatJoinRequest: (chatId, userId) =>
    bot.api.approveChatJoinRequest(chatId, userId).then(() => undefined),
  getChatOrThrow,
  getUserOrThrow,
  deletePayment: deleteSubscriptionPayment,
  findSubscriptionByUserAndChat: getSubscriptionByUserAndChat,
  recordPayoutInvoice,
  recordFeePayoutInvoice,
  masterWallet: lnbitsMasterWallet,
  getUserWallet,
  notifier,
  log: logger,
  feePercent: config.SUBSCRIPTION_FEE_PERCENT,
  translate,
})

/** @deprecated Prefer settleService.complete — kept for call-site compatibility. */
export async function completeSubscriptionPayment(
  payment: Parameters<typeof settleService.complete>[0],
): Promise<CompleteSubscriptionPaymentResult> {
  return settleService.complete(payment)
}

/** @deprecated Prefer settleService.distributeOnce — kept for call-site compatibility. */
export async function distributeSubscriptionPaymentOnce(
  payment: Parameters<typeof settleService.distributeOnce>[0],
  chatOwnerId: Parameters<typeof settleService.distributeOnce>[1],
): Promise<DistributeOnceResult> {
  return settleService.distributeOnce(payment, chatOwnerId)
}

export type {CompleteSubscriptionPaymentResult, DistributeOnceResult}
