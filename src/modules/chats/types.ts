import type {Chat, User} from '@infra/db/types.js'

export type ChatWithOwner = Chat & {owner: User}
