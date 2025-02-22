import {usersTable, conversationsTable, type pendingInvoicesTable, chatsTable} from './schema.js'

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
