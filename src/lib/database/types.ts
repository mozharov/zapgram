import {usersTable, conversationsTable, type pendingInvoicesTable} from './schema.js'

export type User = typeof usersTable.$inferSelect
type UserInsert = typeof usersTable.$inferInsert
export interface NewUser extends UserInsert {
  id: number
}

export type Conversation = typeof conversationsTable.$inferSelect
export type NewConversation = typeof conversationsTable.$inferInsert

export type PendingInvoice = typeof pendingInvoicesTable.$inferSelect
export type NewPendingInvoice = typeof pendingInvoicesTable.$inferInsert
