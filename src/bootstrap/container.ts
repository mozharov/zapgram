import {type AppConfig, createConfig} from '@config'
import type {AppDatabase} from '@infra/db/client.js'
import {createDb, migrateDb} from '@infra/db/client.js'
import {createMasterWallet, type MasterWalletInstance} from '@infra/lnbits/master-wallet.js'
import {type AppLogger, createLogger} from '@infra/logger.js'
import {createPostHog} from '@infra/posthog.js'
import {createBot} from '@infra/telegram/bot.js'
import {type ChatRepository, createChatRepository} from '@modules/chats/repository.js'
import {
  type ConversationRepository,
  createConversationRepository,
} from '@modules/conversations/repository.js'
import {createInvoiceRepository, type InvoiceRepository} from '@modules/invoices/repository.js'
import {createTelegramNotifier, type Notifier} from '@modules/notifications/notifier.js'
import {createGrantSubscriptionAccess} from '@modules/subscriptions/access.js'
import {
  createSubscriptionIntentRepository,
  type SubscriptionIntentRepository,
} from '@modules/subscriptions/intent-repository.js'
import {
  createJoinInvoiceService,
  type JoinInvoiceService,
} from '@modules/subscriptions/join-invoice.service.js'
import {
  createSubscriptionPaymentRepository,
  type SubscriptionPaymentRepository,
} from '@modules/subscriptions/payment-repository.js'
import {createRenewalService, type RenewalService} from '@modules/subscriptions/renewal.service.js'
import {
  createSubscriptionRepository,
  type SubscriptionRepository,
} from '@modules/subscriptions/repository.js'
import {createSettleService, type SettleService} from '@modules/subscriptions/settle.service.js'
import {createUserRepository, type UserRepository} from '@modules/users/repository.js'
import {createUserWalletFactory} from '@modules/wallet/user-wallet.service.js'
import type {BotContext} from '@telegram/context.js'
import {translate} from '@telegram/i18n/i18n.js'
import type {Bot} from 'grammy'
import type pino from 'pino'
import {setRuntime} from '../runtime.js'

const INVOICE_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export type AppContainer = {
  config: AppConfig
  log: AppLogger & pino.Logger
  posthog: ReturnType<typeof createPostHog>
  db: AppDatabase
  bot: Bot<BotContext>
  masterWallet: MasterWalletInstance
  notifier: Notifier
  users: UserRepository
  chats: ChatRepository
  subscriptions: SubscriptionRepository
  subscriptionIntents: SubscriptionIntentRepository
  joinInvoiceService: JoinInvoiceService
  payments: SubscriptionPaymentRepository
  invoices: InvoiceRepository
  conversations: ConversationRepository
  grantAccess: ReturnType<typeof createGrantSubscriptionAccess>
  getUserWallet: ReturnType<typeof createUserWalletFactory>
  settleService: SettleService
  renewalService: RenewalService
}

/**
 * Composition root: build all process dependencies in dependency order and
 * publish them via setRuntime() for leaf handlers/jobs.
 */
export async function createContainer(env: NodeJS.ProcessEnv = process.env): Promise<AppContainer> {
  const config = createConfig(env)
  const log = createLogger(config) as AppLogger & pino.Logger
  const posthog = createPostHog(config)

  const db = createDb(config.DB_URL)
  if (config.DB_MIGRATE) migrateDb(db, './drizzle', log)

  const masterWallet = createMasterWallet(config)
  await masterWallet.checkStatus()

  const bot = createBot<BotContext>(
    config.BOT_TOKEN,
    config.botInfo,
    config.BOT_API_ROOT ? {apiRoot: config.BOT_API_ROOT} : undefined,
  )
  const notifier = createTelegramNotifier(bot.api, log)

  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  const subscriptions = createSubscriptionRepository(db)
  const subscriptionIntents = createSubscriptionIntentRepository(db)
  const joinInvoiceService = createJoinInvoiceService({
    reserveInvoiceAttempt: (identity, now) =>
      subscriptionIntents.reserveInvoiceAttempt(identity, now),
    finalizeReservedAttempt: (intentId, reservationId, data, now) =>
      subscriptionIntents.finalizeReservedAttempt(intentId, reservationId, data, now),
    releaseAttemptReservation: (intentId, reservationId) =>
      subscriptionIntents.releaseAttemptReservation(intentId, reservationId),
    createInvoice: (sats, expirySeconds) => masterWallet.createInvoice(sats, expirySeconds),
    invoiceExpirySeconds: INVOICE_EXPIRY,
  })
  const payments = createSubscriptionPaymentRepository(db)
  const invoices = createInvoiceRepository(db)
  const conversations = createConversationRepository(db)
  const grantAccess = createGrantSubscriptionAccess(db, log)
  const getUserWallet = createUserWalletFactory({
    masterWallet,
    baseUrl: config.LNBITS_URL,
    memoFooter: config.memoFooter,
    log,
  })

  const settleService = createSettleService({
    recordSettleAttempt: id => payments.recordSettleAttempt(id),
    claimPaidAttempt: (id, claimedAt) => payments.claimPaidAttempt(id, claimedAt),
    markWinnerCompleted: (id, processedAt) => payments.markWinnerCompleted(id, processedAt),
    grantAccess,
    approveChatJoinRequest: (chatId, userId) =>
      bot.api.approveChatJoinRequest(chatId, userId).then(() => undefined),
    getChatOrThrow: id => chats.getOrThrow(id),
    getUserOrThrow: id => users.getOrThrow(id),
    findSubscriptionByUserAndChat: (userId, chatId) =>
      subscriptions.findByUserAndChat(userId, chatId),
    recordPayoutInvoice: (id, hash) => payments.recordPayoutInvoice(id, hash),
    recordFeePayoutInvoice: (id, hash) => payments.recordFeePayoutInvoice(id, hash),
    recordRefundInvoice: (id, hash) => payments.recordRefundInvoice(id, hash),
    markRefundCredited: (id, refundedAt) => payments.markRefundCredited(id, refundedAt),
    masterWallet,
    getUserWallet,
    notifier,
    log,
    feePercent: config.SUBSCRIPTION_FEE_PERCENT,
    translate,
    posthog,
  })

  const renewalService = createRenewalService({
    getPendingPaymentForSubscription: (userId, chatId) =>
      payments.getPendingForSubscription(userId, chatId),
    createSubscriptionPayment: data => payments.create(data),
    masterWallet,
    getUserWallet,
    completePayment: payment => settleService.complete(payment),
    notifier,
    log,
    translate,
    invoiceExpirySeconds: INVOICE_EXPIRY,
  })

  const container: AppContainer = {
    config,
    log,
    posthog,
    db,
    bot,
    masterWallet,
    notifier,
    users,
    chats,
    subscriptions,
    subscriptionIntents,
    joinInvoiceService,
    payments,
    invoices,
    conversations,
    grantAccess,
    getUserWallet,
    settleService,
    renewalService,
  }

  setRuntime(container)
  return container
}
