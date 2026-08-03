import type {Chat, Subscription} from '@infra/db/types.js'

export type SubscriptionWithChat = Subscription & {chat: Chat}
