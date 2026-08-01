import {type AppConfig, createConfig} from '@config'
import type {AppDatabase} from '@infra/db/client.js'
import {createDb, migrateDb} from '@infra/db/client.js'
import {createMasterWallet, type MasterWalletInstance} from '@infra/lnbits/master-wallet.js'
import {type AppLogger, createLogger} from '@infra/logger.js'
import {createBot} from '@infra/telegram/bot.js'
import {createChatRepository} from '@modules/chats/repository.js'
import {createTelegramNotifier, type Notifier} from '@modules/notifications/notifier.js'
import {createGrantSubscriptionAccess} from '@modules/subscriptions/access.js'
import {createSubscriptionPaymentRepository} from '@modules/subscriptions/payment-repository.js'
import {createRenewalService, type RenewalService} from '@modules/subscriptions/renewal.service.js'
import {createSubscriptionRepository} from '@modules/subscriptions/repository.js'
import {createSettleService, type SettleService} from '@modules/subscriptions/settle.service.js'
import {createUserRepository} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import type {BotContext} from '@telegram/context.js'
import {translate} from '@telegram/i18n/i18n.js'
import type {Bot} from 'grammy'
import type pino from 'pino'

const INVOICE_EXPIRY = 60 * 60 * 24 * 1 // 1 day

export type AppContainer = {
  config: AppConfig
  log: AppLogger & pino.Logger
  db: AppDatabase
  bot: Bot<BotContext>
  masterWallet: MasterWalletInstance
  notifier: Notifier
  settleService: SettleService
  renewalService: RenewalService
}

/**
 * Composition root: build all process dependencies in dependency order.
 * Legacy module-level singletons remain until step 11 for handlers/jobs that still import them.
 */
export async function createContainer(env: NodeJS.ProcessEnv = process.env): Promise<AppContainer> {
  const config = createConfig(env)
  const log = createLogger(config) as AppLogger & pino.Logger

  const db = createDb(config.DB_URL)
  if (config.DB_MIGRATE) migrateDb(db)

  const masterWallet = createMasterWallet(config)
  await masterWallet.checkStatus()

  const bot = createBot<BotContext>(config.BOT_TOKEN, config.botInfo)
  const notifier = createTelegramNotifier(bot.api, log)

  const users = createUserRepository(db)
  const chats = createChatRepository(db)
  const subscriptions = createSubscriptionRepository(db)
  const payments = createSubscriptionPaymentRepository(db)
  const grantAccess = createGrantSubscriptionAccess(db, log)

  const settleService = createSettleService({
    recordSettleAttempt: id => payments.recordSettleAttempt(id),
    grantAccess,
    approveChatJoinRequest: (chatId, userId) =>
      bot.api.approveChatJoinRequest(chatId, userId).then(() => undefined),
    getChatOrThrow: id => chats.getOrThrow(id),
    getUserOrThrow: id => users.getOrThrow(id),
    deletePayment: id => payments.delete(id),
    findSubscriptionByUserAndChat: (userId, chatId) =>
      subscriptions.findByUserAndChat(userId, chatId),
    recordPayoutInvoice: (id, hash) => payments.recordPayoutInvoice(id, hash),
    recordFeePayoutInvoice: (id, hash) => payments.recordFeePayoutInvoice(id, hash),
    masterWallet,
    getUserWallet,
    notifier,
    log,
    feePercent: config.SUBSCRIPTION_FEE_PERCENT,
    translate,
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

  return {
    config,
    log,
    db,
    bot,
    masterWallet,
    notifier,
    settleService,
    renewalService,
  }
}
