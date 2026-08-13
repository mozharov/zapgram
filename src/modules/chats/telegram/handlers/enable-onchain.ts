import {getAccessibleChatForOwner} from '@modules/chats/repository.js'
import {chatOnchainEnableRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {enablingOnchain} from '../conversations/enabling-onchain.js'

export const enableOnchainCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId} = chatOnchainEnableRoute.parse(ctx.match)
  const chat = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))
  return ctx.conversation.enter(enablingOnchain.name, chat.id)
}
