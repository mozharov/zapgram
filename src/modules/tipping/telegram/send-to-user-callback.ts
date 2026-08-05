import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {sendingToUser} from './sending-to-user.js'

export const sendToUserCallback = async (ctx: BotContext) => {
  await deleteMessageSafely(ctx)
  await ctx.conversation.enter(sendingToUser.name)
}
