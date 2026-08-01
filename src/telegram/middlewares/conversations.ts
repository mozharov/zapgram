import {
  type ConversationData,
  conversations as grammyConversations,
  type VersionedState,
} from '@grammyjs/conversations'
import {parseMode} from '@infra/telegram/parse-mode.js'
import {
  createOrUpdateConversation,
  deleteConversation,
  getConversation,
} from '@modules/conversations/repository.js'
import type {BotContext, ConversationContext} from '@telegram/context.js'
import {Composer} from 'grammy'
import {attachUser} from './attach-user.js'
import {i18n} from './i18n.js'
import {lnbitsWallet} from './lnbits-wallet.js'
import {logger} from './logger.js'

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
