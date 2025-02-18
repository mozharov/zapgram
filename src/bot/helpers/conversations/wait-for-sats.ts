import {InlineKeyboard} from 'grammy'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'

const MAX_AMOUNT = 100000000

export async function waitForSats(conversation: BotConversation, ctx: ConversationContext) {
  const message = await replyWithWaitForSats(ctx)
  const sats = await conversation.form.int({
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      if (ctx.update.message?.text) await ctx.reply(ctx.t('wait-for-sats.invalid'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))
  if (sats > MAX_AMOUNT || sats <= 0) {
    await ctx.reply(ctx.t('wait-for-sats.invalid'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }
  return sats
}

function replyWithWaitForSats(ctx: ConversationContext) {
  return ctx.reply(ctx.t('wait-for-sats'), {
    reply_markup: new InlineKeyboard([[{callback_data: 'cancel', text: ctx.t('button.cancel')}]]),
  })
}
