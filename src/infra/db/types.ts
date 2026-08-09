import type {
  chatsTable,
  conversationsTable,
  donationPlatformStatsTable,
  donationsTable,
  onchainChatPaymentsTable,
  pendingInvoicesTable,
  subscriptionIntentsTable,
  subscriptionPaymentsTable,
  subscriptionsTable,
  usersTable,
} from './schema.js'

export type User = typeof usersTable.$inferSelect
type UserInsert = typeof usersTable.$inferInsert
export interface NewUser extends UserInsert {
  id: number
}

export type Conversation = typeof conversationsTable.$inferSelect
export type NewConversation = typeof conversationsTable.$inferInsert

export type PendingInvoice = typeof pendingInvoicesTable.$inferSelect
export type NewPendingInvoice = typeof pendingInvoicesTable.$inferInsert

export type Chat = typeof chatsTable.$inferSelect
export type NewChat = typeof chatsTable.$inferInsert

export type Subscription = typeof subscriptionsTable.$inferSelect
export type SubscriptionInsert = typeof subscriptionsTable.$inferInsert
export type NewSubscription = Omit<SubscriptionInsert, 'id'>

export type SubscriptionIntent = typeof subscriptionIntentsTable.$inferSelect
export type SubscriptionIntentInsert = typeof subscriptionIntentsTable.$inferInsert
export type NewSubscriptionIntent = Omit<SubscriptionIntentInsert, 'id'>

export type SubscriptionPayment = typeof subscriptionPaymentsTable.$inferSelect
export type SubscriptionPaymentInsert = typeof subscriptionPaymentsTable.$inferInsert
export type NewSubscriptionPayment = Omit<SubscriptionPaymentInsert, 'id' | 'intentId'> & {
  intentId?: string
}

export type OnchainChatPayment = typeof onchainChatPaymentsTable.$inferSelect
export type OnchainChatPaymentInsert = typeof onchainChatPaymentsTable.$inferInsert
export type NewOnchainChatPayment = Omit<OnchainChatPaymentInsert, 'id'>

export type Donation = typeof donationsTable.$inferSelect
export type DonationInsert = typeof donationsTable.$inferInsert
export type NewDonation = Omit<DonationInsert, 'id'>

export type DonationPlatformStats = typeof donationPlatformStatsTable.$inferSelect
