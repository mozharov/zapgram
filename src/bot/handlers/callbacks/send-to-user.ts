import type {BotContext} from '../../context.js'
import {sendingToUser} from '../../conversations/sending-to-user.js'

export const sendToUserCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await ctx.conversation.enter(sendingToUser.name)
}
