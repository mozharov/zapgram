import type {
  Chat,
  NewChat,
  NewPendingInvoice,
  NewSubscription,
  NewSubscriptionPayment,
  PendingInvoice,
  Subscription,
  SubscriptionPayment,
  User,
} from '@infra/db/types.js'
import type {E2E} from '../harness.js'
import {CHAT_GROUP, OWNER, USER_A} from './ids.js'

export async function seedUser(
  e2e: E2E,
  opts: Partial<Omit<User, 'id' | 'nwcUrl' | 'createdAt'>> & {id?: number} = {},
): Promise<User> {
  const id = opts.id ?? USER_A
  e2e.ln.state.ensureUser(String(id))
  return e2e.container.users.createOrUpdate({
    id,
    username: `user_${id}`,
    firstName: `User ${id}`,
    languageCode: 'en',
    nwcTips: false,
    ...opts,
    nwcUrl: null,
  })
}

export async function seedChat(
  e2e: E2E,
  opts: Partial<Omit<NewChat, 'id' | 'ownerId'>> & {id?: number; ownerId?: number} = {},
): Promise<Chat> {
  return e2e.container.chats.createOrUpdate({
    id: opts.id ?? CHAT_GROUP,
    ownerId: opts.ownerId ?? OWNER,
    title: 'E2E paid chat',
    type: 'supergroup',
    price: 1000,
    status: 'inactive',
    paymentType: 'one_time',
    ...opts,
  })
}

export function seedActivePaidChat(
  e2e: E2E,
  opts: Partial<Omit<NewChat, 'id' | 'ownerId' | 'status'>> & {
    id?: number
    ownerId?: number
  } = {},
): Promise<Chat> {
  return seedChat(e2e, {...opts, status: 'active'})
}

export function seedSubscription(
  e2e: E2E,
  opts: Partial<Omit<NewSubscription, 'userId' | 'chatId'>> & {
    userId?: number
    chatId?: number
  } = {},
): Promise<Subscription> {
  return e2e.container.subscriptions.create({
    userId: opts.userId ?? USER_A,
    chatId: opts.chatId ?? CHAT_GROUP,
    price: 1000,
    endsAt: null,
    autoRenew: true,
    notificationSent: false,
    ...opts,
  })
}

export function seedExpiringSubscription(
  e2e: E2E,
  opts: Partial<Omit<NewSubscription, 'userId' | 'chatId' | 'endsAt'>> & {
    userId?: number
    chatId?: number
    endsInMs?: number
  } = {},
): Promise<Subscription> {
  const {endsInMs = 60 * 60 * 1000, ...subscription} = opts
  return seedSubscription(e2e, {...subscription, endsAt: new Date(Date.now() + endsInMs)})
}

export async function seedSubscriptionPayment(
  e2e: E2E,
  opts: Partial<
    Omit<NewSubscriptionPayment, 'userId' | 'chatId' | 'paymentRequest' | 'paymentHash'>
  > & {
    userId?: number
    chatId?: number
    paid: boolean
    expiresInMs?: number
  },
): Promise<SubscriptionPayment> {
  const userId = opts.userId ?? USER_A
  const price = opts.price ?? 1000
  const masterWallet = e2e.ln.state.walletByApiKey(e2e.container.config.LNBITS_ADMIN_KEY)
  if (!masterWallet) throw new Error('Fake LNbits master wallet not found')
  const invoice = e2e.ln.state.createInvoice({
    wallet: masterWallet,
    sats: price,
    memo: 'E2E subscription payment',
    expirySec: Math.ceil((opts.expiresInMs ?? 24 * 60 * 60 * 1000) / 1000),
  })

  if (opts.paid) {
    const payer = walletFor(e2e, userId)
    e2e.ln.state.credit(payer.id, invoice.amountMsat)
    e2e.ln.state.payInvoice({payerWallet: payer, bolt11: invoice.bolt11})
  } else {
    e2e.ln.state.ensureUser(String(userId))
  }

  return e2e.container.payments.create({
    userId,
    chatId: opts.chatId ?? CHAT_GROUP,
    paymentRequest: invoice.bolt11,
    paymentHash: invoice.paymentHash,
    price,
    subscriptionType: opts.subscriptionType ?? 'one_time',
    kind: opts.kind ?? 'join',
    settledAt: opts.settledAt,
    settleAttempts: opts.settleAttempts,
    payoutHash: opts.payoutHash,
    feePayoutHash: opts.feePayoutHash,
  })
}

export async function seedPendingInvoice(
  e2e: E2E,
  opts: Partial<Omit<NewPendingInvoice, 'userId' | 'paymentRequest' | 'paymentHash'>> & {
    userId?: number
    sats?: number
    expiresInMs?: number
  } = {},
): Promise<PendingInvoice> {
  const userId = opts.userId ?? USER_A
  const expiresInMs = opts.expiresInMs ?? 60 * 60 * 1000
  const wallet = walletFor(e2e, userId)
  const invoice = e2e.ln.state.createInvoice({
    wallet,
    sats: opts.sats ?? 21,
    memo: 'E2E pending invoice',
    expirySec: Math.ceil(expiresInMs / 1000),
  })
  return e2e.container.invoices.create({
    userId,
    paymentRequest: invoice.bolt11,
    paymentHash: invoice.paymentHash,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + expiresInMs),
    createdAt: opts.createdAt,
  })
}

function walletFor(e2e: E2E, userId: number) {
  const user = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for user ${userId}`)
  return wallet
}
