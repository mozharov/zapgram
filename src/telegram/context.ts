import type {Conversation, ConversationFlavor} from '@grammyjs/conversations'
import type {I18nFlavor} from '@grammyjs/i18n'
import type {User} from '@infra/db/types.js'
import type {UserWallet} from '@infra/lnbits/user-wallet.js'
import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'
import type {Context} from 'grammy'

export type BaseContext = ConversationFlavor<Context & I18nFlavor> & {
  log: AppLogger
  update: {
    reqId: string
  }
}

export type BotContext = BaseContext & {
  user: User & {nwc?: NostrWallet; wallet: UserWallet}
}

export type ConversationContext = BotContext
export type BotConversation = Conversation<BotContext, ConversationContext>
