import type {BotContext} from '../../context.js'
import {connectingNWC} from '../../conversations/connecting-nwc.js'

export const connectNwcCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await ctx.conversation.enter(connectingNWC.name)
}
