import {
  type usersTable,
  type conversationsTable,
  type pendingInvoicesTable,
  type chatsTable,
  type subscriptionsTable,
  type subscriptionPaymentsTable,
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
export type NewSubscription = typeof subscriptionsTable.$inferInsert

export type SubscriptionPayment = typeof subscriptionPaymentsTable.$inferSelect
export type NewSubscriptionPayment = typeof subscriptionPaymentsTable.$inferInsert
