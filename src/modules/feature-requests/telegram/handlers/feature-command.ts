import {requestingFeature} from '@modules/feature-requests/telegram/conversations/requesting-feature.js'
import type {BotContext} from '@telegram/context.js'

export async function featureCommand(ctx: BotContext) {
  const initialText = typeof ctx.match === 'string' ? ctx.match : ''
  await ctx.conversation.enter(requestingFeature.name, initialText)
}
