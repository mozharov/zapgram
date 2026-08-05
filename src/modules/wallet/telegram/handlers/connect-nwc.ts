import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {connectingNWC} from '../conversations/connecting-nwc.js'

export const connectNwcCallback = async (ctx: BotContext) => {
  await deleteMessageSafely(ctx)
  await ctx.conversation.enter(connectingNWC.name)
}
