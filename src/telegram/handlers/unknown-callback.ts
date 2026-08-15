import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'

export async function unknownCallback(ctx: BotContext) {
  // A button nobody handles is a routing bug or a keyboard from an older deploy — worth seeing.
  ctx.log.warn('Callback query without a handler')
  await deleteMessageSafely(ctx)
  return ctx.answerCallbackQuery({text: ctx.t('callback-answer.unknown')})
}
