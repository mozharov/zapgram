import {Composer} from 'grammy'
import {
  conversations as grammyConversations,
  type ConversationData,
  type VersionedState,
} from '@grammyjs/conversations'
import type {BotContext, ConversationContext} from '../context.js'
import {
  createOrUpdateConversation,
  deleteConversation,
  getConversation,
} from '../../models/conversation.js'
import {parseMode} from '@grammyjs/parse-mode'
import {logger} from './logger.js'
import {i18n} from './i18n.js'
import {attachUser} from './attach-user.js'
import {lnbitsWallet} from './lnbits-wallet.js'

export const conversations = new Composer<BotContext>()

conversations.use(
  grammyConversations<BotContext, ConversationContext>({
    plugins: [
      async (ctx, next) => {
        ctx.api.config.use(parseMode('HTML'))
        await next()
      },
      logger,
      i18n,
      attachUser,
      lnbitsWallet,
    ],
    storage: {
      type: 'key', // unique for each chat
      version: 0,
      adapter: {
        read: async key => {
          const conversation = await getConversation(key)
          if (!conversation) return
          return {
            version: conversation.version as VersionedState<ConversationData>['version'],
            state: conversation.state as ConversationData,
          }
        },
        write: async (key, state) => {
          await createOrUpdateConversation({
            key,
            state: state.state,
            version: state.version,
          })
        },
        delete: deleteConversation,
      },
    },
  }),
)
