import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {notifier} from '@modules/notifications/notifier.js'
import {
  createSubscriptionPayment,
  getPendingPaymentForSubscription,
} from '@modules/subscriptions/payment-repository.js'
import {translate} from '../../bot/lib/i18n.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {createRenewalService} from './renewal.service.js'
import {settleService} from './settle.js'

const INVOICE_EXPIRY = 60 * 60 * 24 * 1 // 1 day

/** Default renewal service — removed when bootstrap owns composition (step 11). */
export const renewalService = createRenewalService({
  getPendingPaymentForSubscription,
  createSubscriptionPayment,
  masterWallet: lnbitsMasterWallet,
  getUserWallet,
  completePayment: payment => settleService.complete(payment),
  notifier,
  log: logger,
  translate,
  invoiceExpirySeconds: INVOICE_EXPIRY,
})

export type {RenewalOutcome} from './renewal.service.js'
