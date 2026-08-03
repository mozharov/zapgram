import type {BotContext} from '@telegram/context.js'

export async function unknownCallback(ctx: BotContext) {
  await ctx.deleteMessage()
  return ctx.answerCallbackQuery({text: ctx.t('callback-answer.unknown')})
}
