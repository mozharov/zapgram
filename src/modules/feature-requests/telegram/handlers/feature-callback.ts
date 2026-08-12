import {requestingFeature} from '@modules/feature-requests/telegram/conversations/requesting-feature.js'
import type {BotContext} from '@telegram/context.js'

export async function featureCallback(ctx: BotContext) {
  await ctx.answerCallbackQuery()
  await ctx.conversation.enter(requestingFeature.name, '')
}
