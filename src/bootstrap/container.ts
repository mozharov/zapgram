import {type AppConfig, createConfig} from '@config'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import type {AppDatabase} from '@infra/db/client.js'
import {createDb, migrateDb} from '@infra/db/client.js'
import {createMasterWallet, type MasterWalletInstance} from '@infra/lnbits/master-wallet.js'
import {
  createLnbitsRateFetcher,
  createRateService,
  type RateService,
} from '@infra/lnbits/rate-service.js'
import {createSatsPayClient, type SatsPayClient} from '@infra/lnbits/satspay.js'
import {createWatchOnlyClient, type WatchOnlyClient} from '@infra/lnbits/watchonly.js'
import {type AppLogger, createLogger} from '@infra/logger.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {createPostHog} from '@infra/posthog.js'
import {createBot} from '@infra/telegram/bot.js'
import {
  type BroadcastService,
  createBroadcastService,
} from '@modules/broadcast/broadcast.service.js'
import {formatBroadcastReport, formatBroadcastStarted} from '@modules/broadcast/format.js'
import {type BroadcastRepository, createBroadcastRepository} from '@modules/broadcast/repository.js'
import {isTelegramUserUnreachableError} from '@modules/broadcast/telegram-errors.js'
import {type ChatRepository, createChatRepository} from '@modules/chats/repository.js'
import {
  type ConversationRepository,
  createConversationRepository,
} from '@modules/conversations/repository.js'
import {
  createDonationCollectService,
  type DonationCollectService,
} from '@modules/donations/collect.service.js'
import {createDonationPayService, type DonationPayService} from '@modules/donations/pay.service.js'
import {createDonationRepository, type DonationRepository} from '@modules/donations/repository.js'
import {
  createFeatureRequestService,
  type FeatureRequestService,
  formatFeatureRequestAdminMeta,
} from '@modules/feature-requests/submit.service.js'
import {createInvoiceRepository, type InvoiceRepository} from '@modules/invoices/repository.js'
import type {Notifier} from '@modules/notifications/notifier.js'
import {
  type CompleteOnchainJoinService,
  createCompleteOnchainJoinService,
} from '@modules/onchain/complete.service.js'
import {
  createOnchainEnableService,
  type OnchainEnableService,
} from '@modules/onchain/enable.service.js'
import {
  createOnchainJoinPaymentService,
  type OnchainJoinPaymentService,
} from '@modules/onchain/payment.service.js'
import {
  createOnchainPaymentRepository,
  type OnchainPaymentRepository,
} from '@modules/onchain/repository.js'
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
import {
  createChromeNotifier,
  createNotificationChrome,
  type NotificationChrome,
  parseBaseMarkup,
} from '@telegram/helpers/notification-chrome.js'
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
  rates: RateService
  notifier: Notifier
  notificationChrome: NotificationChrome
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
  watchOnly: WatchOnlyClient
  satsPay: SatsPayClient
  onchainPayments: OnchainPaymentRepository
  onchainEnableService: OnchainEnableService
  onchainJoinPaymentService: OnchainJoinPaymentService
  completeOnchainJoin: CompleteOnchainJoinService
  donations: DonationRepository
  donationPay: DonationPayService
  donationCollect: DonationCollectService
  featureRequests: FeatureRequestService
  broadcasts: BroadcastRepository
  broadcastService: BroadcastService
  /** Shared i18n for jobs / services that cannot import @telegram/* directly. */
  translate: typeof translate
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
  const health = await masterWallet.checkStatus()
  log.info({lnbitsUpTime: health.up_time}, 'LNbits reachable')

  const rates = createRateService({
    fetchUsdBtcRate: createLnbitsRateFetcher(config.LNBITS_URL, log),
    log,
  })

  const bot = createBot<BotContext>(
    config.BOT_TOKEN,
    config.botInfo,
    config.BOT_API_ROOT ? {apiRoot: config.BOT_API_ROOT} : undefined,
  )
  const users = createUserRepository(db, {
    defaultDonationPercent: config.DONATION_DEFAULT_PERCENT,
    log,
  })
  const notificationChrome = createNotificationChrome({
    findUser: id => users.findById(id),
    updateUser: (id, data) => users.update(id, data),
    editMessageReplyMarkup: (chatId, messageId, extra) =>
      bot.api.editMessageReplyMarkup(chatId, messageId, extra),
    deleteMessage: (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
    log,
  })
  const notifier = createChromeNotifier(bot.api, log, notificationChrome)
  const donations = createDonationRepository(db)
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
    log,
  })
  const payments = createSubscriptionPaymentRepository(db)
  const invoices = createInvoiceRepository(db)
  const conversations = createConversationRepository(db)
  const grantAccess = createGrantSubscriptionAccess(db, log)
  const paymentWebhookUrl = buildLnbitsPaymentWebhookUrl(config.HOST, config.BOT_WEBHOOK_SECRET)
  const getUserWallet = createUserWalletFactory({
    masterWallet,
    baseUrl: config.LNBITS_URL,
    memoFooter: config.memoFooter,
    log,
    paymentWebhookUrl,
  })

  const donationPay = createDonationPayService({
    createFeeCollectionInvoice: sats => masterWallet.createFeeCollectionInvoice(sats),
    getUserWallet,
    insertDonation: input => donations.insertDonation(input),
    log,
    posthog,
    createNwc: nwcUrl => new NostrWallet(nwcUrl, config.memoFooter, log),
  })

  const donationCollect = createDonationCollectService({
    payService: donationPay,
    insertDonation: input => donations.insertDonation(input),
    getUser: id => users.getOrThrow(id),
    notifyDonationFailed: async (userId, donationSats, languageCode) => {
      const btcUsd = await rates.getBtcUsd()
      const usdSuffix = btcUsd === null ? '' : formatUsdSuffix(satsToUsd(donationSats, btcUsd))
      const text = translate('donation.failed', languageCode, {donationSats, usdSuffix})
      await notifier.send(userId, text)
    },
    log,
    posthog,
  })

  const featureRequests = createFeatureRequestService({
    payDonation: input => donationPay.payDonation(input),
    notify: (userId, text) => notifier.send(userId, text),
    copyMessage: (toUserId, fromChatId, messageId) =>
      notifier.copyMessage(toUserId, fromChatId, messageId),
    adminTelegramIds: config.ADMIN_TELEGRAM_IDS,
    formatAdminMeta: formatFeatureRequestAdminMeta,
    log,
    posthog,
  })

  const broadcasts = createBroadcastRepository(db)
  const broadcastService = createBroadcastService({
    broadcasts,
    users,
    copyMessage: async (toUserId, fromChatId, messageId, sourceReplyMarkup) => {
      try {
        await notificationChrome.deliver(
          toUserId,
          parseBaseMarkup(sourceReplyMarkup) ?? undefined,
          markup => bot.api.copyMessage(toUserId, fromChatId, messageId, {reply_markup: markup}),
        )
        return 'sent'
      } catch (error) {
        if (isTelegramUserUnreachableError(error)) {
          log.info({toUserId, error}, 'Broadcast target unreachable')
          return 'blocked'
        }
        log.error({error, toUserId, fromChatId, messageId}, 'Broadcast copyMessage failed')
        return 'failed'
      }
    },
    notifyAdmin: (adminUserId, text) => notifier.send(adminUserId, text),
    formatStarted: formatBroadcastStarted,
    formatReport: formatBroadcastReport,
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
    getBtcUsd: () => rates.getBtcUsd(),
    posthog,
  })

  const renewalService = createRenewalService({
    getPendingPaymentForSubscription: (userId, chatId) =>
      payments.getPendingForSubscription(userId, chatId),
    createSubscriptionPayment: data => payments.create(data),
    masterWallet,
    getUserWallet,
    getUserNwcUrl: async userId => {
      const user = await users.findById(userId)
      return user?.nwcUrl
    },
    createNwc: nwcUrl => new NostrWallet(nwcUrl, config.memoFooter, log),
    completePayment: payment => settleService.complete(payment),
    notifier,
    log,
    translate,
    getBtcUsd: () => rates.getBtcUsd(),
    invoiceExpirySeconds: INVOICE_EXPIRY,
  })

  const watchOnly = createWatchOnlyClient({
    baseUrl: config.LNBITS_URL,
    adminKey: config.LNBITS_ADMIN_KEY,
    log,
  })
  const satsPay = createSatsPayClient({
    baseUrl: config.LNBITS_URL,
    adminKey: config.LNBITS_ADMIN_KEY,
    log,
  })
  const onchainPayments = createOnchainPaymentRepository(db)
  const onchainEnableService = createOnchainEnableService({
    watchOnly,
    updateChat: (id, data) => chats.update(id, data),
    network: config.LNBITS_ONCHAIN_NETWORK,
    log,
  })
  const onchainJoinPaymentService = createOnchainJoinPaymentService({
    onchainPayments,
    satsPay,
    host: config.HOST,
    webhookSecret: config.BOT_WEBHOOK_SECRET,
    log,
  })
  const completeOnchainJoin = createCompleteOnchainJoinService({
    onchainPayments,
    getOrCreateJoinIntent: (userId, chatId) =>
      subscriptionIntents.getOrCreateActive({userId, chatId, kind: 'join'}),
    createSubscriptionPayment: data => payments.create(data),
    findSubscriptionPayment: id => payments.findById(id),
    findSubscriptionPaymentByHash: hash => payments.findByPaymentHash(hash),
    claimPaidAttempt: (id, claimedAt) => payments.claimPaidAttempt(id, claimedAt),
    markWinnerCompleted: (id, processedAt) => payments.markWinnerCompleted(id, processedAt),
    grantAccess,
    approveChatJoinRequest: (chatId, userId) =>
      bot.api.approveChatJoinRequest(chatId, userId).then(() => undefined),
    getChatOrThrow: id => chats.getOrThrow(id),
    getUserOrThrow: id => users.getOrThrow(id),
    notifier,
    editTelegramMessage: async (telegramChatId, telegramMessageId, text) => {
      await bot.api.editMessageText(telegramChatId, telegramMessageId, text)
    },
    log,
    translate,
    getBtcUsd: () => rates.getBtcUsd(),
    posthog,
  })

  const container: AppContainer = {
    config,
    log,
    posthog,
    db,
    bot,
    masterWallet,
    rates,
    notifier,
    notificationChrome,
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
    watchOnly,
    satsPay,
    onchainPayments,
    onchainEnableService,
    onchainJoinPaymentService,
    completeOnchainJoin,
    donations,
    donationPay,
    donationCollect,
    featureRequests,
    broadcasts,
    broadcastService,
    translate,
  }

  setRuntime(container)
  return container
}
