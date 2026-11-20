import {type AppConfig, createConfig} from '@config'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {lnurlRecipientLabel} from '@core/lightning/lnurl-pay.js'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import {classifyPayoutLookup} from '@core/payments/payout-state.js'
import type {AppDatabase} from '@infra/db/client.js'
import {createDb, migrateDb} from '@infra/db/client.js'
import {createInvoiceOriginLookup, probeAdminPaymentList} from '@infra/lnbits/invoice-origin.js'
import {createMasterWallet, type MasterWalletInstance} from '@infra/lnbits/master-wallet.js'
import {
  BACKEND_LIQUIDITY_CHECK_FAILED,
  BACKEND_LIQUIDITY_MODE,
  createOutgoingLiquidityGuard,
  probeFundingSource,
  SEND_PAUSED_NO_BACKEND_LIQUIDITY,
} from '@infra/lnbits/outgoing-liquidity.js'
import {
  createLnbitsRateFetcher,
  createRateService,
  type RateService,
} from '@infra/lnbits/rate-service.js'
import {createSatsPayClient, type SatsPayClient} from '@infra/lnbits/satspay.js'
import {createWatchOnlyClient, type WatchOnlyClient} from '@infra/lnbits/watchonly.js'
import {type AppLogger, createLogger} from '@infra/logger.js'
import {nwcInvoiceMissing, unixDate} from '@infra/nostr/nwc-lookup.js'
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
import {
  createPendingDonationService,
  type PendingDonationService,
} from '@modules/donations/pending.service.js'
import {createDonationRepository, type DonationRepository} from '@modules/donations/repository.js'
import {
  createFeatureRequestService,
  type FeatureRequestService,
  formatFeatureRequestAdminMeta,
} from '@modules/feature-requests/submit.service.js'
import {createLnurlPayAttemptRepository} from '@modules/invoices/lnurl-pay-attempt.repository.js'
import {
  createLnurlPayAttemptService,
  type LnurlPayAttemptService,
} from '@modules/invoices/lnurl-pay-attempt.service.js'
import {createInvoiceRepository, type InvoiceRepository} from '@modules/invoices/repository.js'
import {lnurlRecipientHtml} from '@modules/invoices/telegram/lnurl-payee.js'
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
import {createSatspayGate, type SatspayGate} from '@modules/onchain/satspay-gate.js'
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
import {createDmTransferRepository} from '@modules/tipping/dm-transfer.repository.js'
import {
  createDmTransferService,
  type DmTransferService,
} from '@modules/tipping/dm-transfer.service.js'
import {notifySatsReceivedOutcome} from '@modules/tipping/notify-sats-received.js'
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
import {HTTPError} from 'got'
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
  satspayGate: SatspayGate
  onchainPayments: OnchainPaymentRepository
  onchainEnableService: OnchainEnableService
  onchainJoinPaymentService: OnchainJoinPaymentService
  completeOnchainJoin: CompleteOnchainJoinService
  donations: DonationRepository
  pendingDonations: PendingDonationService
  donationPay: DonationPayService
  donationCollect: DonationCollectService
  dmTransfers: DmTransferService
  lnurlPays: LnurlPayAttemptService
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
  if (config.backendLiquidityGuardUnrecognized !== undefined) {
    log.warn(
      {unrecognized: true, length: config.backendLiquidityGuardUnrecognized.length},
      'BACKEND_LIQUIDITY_GUARD is not recognized; using on',
    )
  }
  const guardEnabled = config.BACKEND_LIQUIDITY_GUARD === 'on'
  const outgoingLiquidity = guardEnabled
    ? createOutgoingLiquidityGuard({
        classifyInvoice: createInvoiceOriginLookup(config.LNBITS_URL, config.LNBITS_BEARER_TOKEN),
        readBalance: () => masterWallet.readFundingSource(),
        log,
        capturePaused: properties => {
          posthog?.capture({
            distinctId: 'lnbits-backend',
            event: SEND_PAUSED_NO_BACKEND_LIQUIDITY,
            properties: {$process_person_profile: false, ...properties},
          })
        },
        captureCheckFailed: properties => {
          posthog?.capture({
            distinctId: 'lnbits-backend',
            event: BACKEND_LIQUIDITY_CHECK_FAILED,
            properties: {$process_person_profile: false, ...properties},
          })
        },
        hasBearer: Boolean(config.LNBITS_BEARER_TOKEN),
      })
    : undefined
  if (outgoingLiquidity) masterWallet.useOutgoingLiquidity(outgoingLiquidity)
  const liquidityMode = outgoingLiquidity
    ? await probeFundingSource({
        hasBearer: Boolean(config.LNBITS_BEARER_TOKEN),
        read: () => masterWallet.readFundingSource(),
        probeClassify: () => probeAdminPaymentList(config.LNBITS_URL, config.LNBITS_BEARER_TOKEN),
      })
    : {mode: 'disabled' as const, reason: 'guard_off' as const, classify: 'skipped' as const}
  if (liquidityMode.reason === 'zero_balance') {
    log.warn(
      {
        liquidityMode: liquidityMode.mode,
        reason: liquidityMode.reason,
        classify: liquidityMode.classify,
      },
      'Funding source balance is 0 with an empty error; NWC without get_balance looks the same',
    )
  }
  log.info(
    {
      liquidityMode: liquidityMode.mode,
      reason: liquidityMode.reason,
      classify: liquidityMode.classify,
    },
    'Funding source liquidity check',
  )
  posthog?.capture({
    distinctId: 'lnbits-backend',
    event: BACKEND_LIQUIDITY_MODE,
    properties: {
      $process_person_profile: false,
      mode: liquidityMode.mode,
      reason: liquidityMode.reason,
      classify: liquidityMode.classify,
    },
  })
  const health = await masterWallet.checkStatus()
  log.info({lnbitsUpTime: health.up_time}, 'LNbits reachable')
  try {
    masterWallet.adoptWalletId(await masterWallet.readWalletId())
  } catch {
    log.warn('Master wallet id was not read')
  }

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
    outgoingLiquidity,
  })

  const pendingDonations = createPendingDonationService({
    donations,
    lookupFeePayment: hash => masterWallet.lookupFeePayment(hash),
    log,
  })
  const donationPay = createDonationPayService({
    issuance: donations,
    pending: pendingDonations,
    createFeeCollectionInvoice: sats => masterWallet.createFeeCollectionInvoice(sats),
    getUserWallet,
    insertDonation: input => donations.insertDonation(input),
    log,
    posthog,
    createNwc: nwcUrl => new NostrWallet(nwcUrl, config.memoFooter, log),
  })

  const dmTransfers = createDmTransferService({
    transfers: createDmTransferRepository(db),
    log,
    createRecipientInvoice: async (toUserId, sats) => {
      const wallet = await getUserWallet(toUserId)
      return wallet.createInvoice({sats})
    },
    lookupRecipient: async (toUserId, hash) => {
      try {
        const wallet = await getUserWallet(toUserId)
        return classifyPayoutLookup(await wallet.lookupPayment(hash))
      } catch (error) {
        if (error instanceof HTTPError && error.response.statusCode === 404) return 'retryable'
        throw error
      }
    },
    createFeeInvoice: sats => masterWallet.createFeeCollectionInvoice(sats),
    lookupFee: async hash => {
      try {
        return classifyPayoutLookup(await masterWallet.lookupFeePayment(hash))
      } catch (error) {
        if (error instanceof HTTPError && error.response.statusCode === 404) return 'retryable'
        throw error
      }
    },
    pay: async (userId, bolt11, rail, options) => {
      if (rail === 'nwc') {
        const payer = await users.getOrThrow(userId)
        if (!payer.nwcUrl) throw new NWCConnectionError()
        await new NostrWallet(payer.nwcUrl, config.memoFooter, log).payInvoice(bolt11)
        return
      }
      const wallet = await getUserWallet(userId)
      const payment = await wallet.payInvoice(bolt11, {
        knownInternal: options?.knownInternal,
      })
      return {paymentHash: payment.payment_hash}
    },
    posthog,
    getUser: id => users.getOrThrow(id),
    notify: async ({toUserId, fromUserId, sats}) => {
      const from = await users.getOrThrow(fromUserId)
      return notifySatsReceivedOutcome(toUserId, sats, from.username)
    },
    notifySender: async ({fromUserId, toUserId, sats, outcome}) => {
      const [from, to] = await Promise.all([
        users.getOrThrow(fromUserId),
        users.getOrThrow(toUserId),
      ])
      const key =
        outcome === 'settled'
          ? 'sending-to-user.sender-settled'
          : outcome === 'needs_review'
            ? 'sending-to-user.still-confirming'
            : 'sending-to-user.sender-not-paid'
      return notifier.send(
        fromUserId,
        translate(key, from.languageCode, {amount: sats, recipient: to.username ?? ''}),
      )
    },
    findDonation: hash => donations.findByPaymentHash(hash),
    insertDonation: input =>
      donations.insertDonation({
        userId: input.userId,
        amountSats: input.amountSats,
        kind: 'percent',
        paymentHash: input.paymentHash,
      }),
  })

  const donationCollect = createDonationCollectService({
    pending: pendingDonations,
    payService: donationPay,
    insertDonation: input => donations.insertDonation(input),
    getUser: id => users.getOrThrow(id),
    notifyDonationFailed: async (userId, donationSats, languageCode, reason) => {
      const btcUsd = await rates.getBtcUsd()
      const usdSuffix = btcUsd === null ? '' : formatUsdSuffix(satsToUsd(donationSats, btcUsd))
      const text =
        reason === 'paused'
          ? translate('donation.paused', languageCode, {donationSats, usdSuffix})
          : translate('donation.failed', languageCode, {donationSats, usdSuffix})
      await notifier.send(userId, text)
    },
    log,
    posthog,
  })

  const lnurlPays = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async (userId, hash, bolt11, rail) => {
      if (rail === 'nwc') {
        const payer = await users.getOrThrow(userId)
        if (!payer.nwcUrl || !bolt11) return {state: 'unknown'}
        try {
          const wallet = new NostrWallet(payer.nwcUrl, config.memoFooter, log)
          const found = await wallet.lookupInvoice(bolt11)
          if (!found.preimage) return {state: 'pending'}
          return {state: 'paid', paidAt: unixDate(found.settled_at)}
        } catch (error) {
          if (nwcInvoiceMissing(error)) return {state: 'retryable'}
          return {state: 'unknown'}
        }
      }
      try {
        const wallet = await getUserWallet(userId)
        // A 404 is the expected "this wallet has not paid" answer, not a failure.
        const found = await wallet.lookupPayment(hash, {quietStatuses: [404]})
        const state = classifyPayoutLookup(found)
        if (state !== 'paid') return {state}
        return {state, paidAt: found.details?.time}
      } catch (error) {
        if (error instanceof HTTPError && error.response.statusCode === 404)
          return {state: 'retryable'}
        return {state: 'unknown'}
      }
    },
    notifySender: async ({fromUserId, recipient, sats, outcome}) => {
      const from = await users.getOrThrow(fromUserId)
      const key =
        outcome === 'settled'
          ? 'lnurl-pay-sender-settled'
          : outcome === 'needs_review'
            ? 'lnurl-pay-still-checking'
            : 'lnurl-pay-sender-not-paid'
      return notifier.send(
        fromUserId,
        translate(key, from.languageCode, {
          recipient: lnurlRecipientHtml(lnurlRecipientLabel(recipient)),
          amount: sats,
        }),
      )
    },
    collectDonation: async ({userId, sats, rail}) => {
      const payer = await users.getOrThrow(userId)
      await donationCollect.tryCollect({
        userId,
        baseAmountSats: sats,
        kind: 'invoice',
        preferredRail: rail,
        nwcUrl: payer.nwcUrl,
        user: payer,
      })
    },
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
  const satspayGate = createSatspayGate({
    probe: () => satsPay.probeExtension(),
    notifier,
    adminTelegramIds: config.ADMIN_TELEGRAM_IDS,
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
      // Settled: that message is the member's proof of access now, not a payment screen. The next
      // menu must leave it alone, so the join pointer lets go of it here.
      await notificationChrome.forgetJoinScreen(telegramChatId, telegramMessageId)
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
    satspayGate,
    onchainPayments,
    onchainEnableService,
    onchainJoinPaymentService,
    completeOnchainJoin,
    donations,
    donationPay,
    pendingDonations,
    donationCollect,
    dmTransfers,
    lnurlPays,
    featureRequests,
    broadcasts,
    broadcastService,
    translate,
  }

  setRuntime(container)
  return container
}
