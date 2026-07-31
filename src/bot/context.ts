import type {Conversation, ConversationFlavor} from '@grammyjs/conversations'
import type {I18nFlavor} from '@grammyjs/i18n'
import type {Context} from 'grammy'
import type {User} from '../lib/database/types.js'
import type {UserWallet} from '../lib/lnbits/user-wallet.js'
import type {AppLogger} from '../lib/logger.js'
import type {NostrWallet} from '../lib/nostr-wallet.js'

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
