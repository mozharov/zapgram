import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'

export async function unknownCallback(ctx: BotContext) {
  await deleteMessageSafely(ctx)
  return ctx.answerCallbackQuery({text: ctx.t('callback-answer.unknown')})
}
