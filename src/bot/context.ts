import {Context} from 'grammy'
import type {AppLogger} from '../lib/logger.js'
import type {I18nFlavor} from '@grammyjs/i18n'
import type {User} from '../lib/database/types.js'
import type {Conversation, ConversationFlavor} from '@grammyjs/conversations'
import {NostrWallet} from '../lib/nostr-wallet.js'
import type {UserWallet} from '../lib/lnbits/user-wallet.js'

export type BotContext = ConversationFlavor<Context & I18nFlavor> & {
  log: AppLogger
  user: User & {nwc?: NostrWallet; wallet: UserWallet}
  update: {
    reqId: string
  }
}

export type ConversationContext = BotContext
export type BotConversation = Conversation<BotContext, ConversationContext>
