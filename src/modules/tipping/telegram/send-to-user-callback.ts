import type {BotContext} from '@telegram/context.js'
import {sendingToUser} from './sending-to-user.js'

export const sendToUserCallback = async (ctx: BotContext) => {
  await ctx.conversation.enter(sendingToUser.name)
}
