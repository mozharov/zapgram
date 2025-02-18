import {InlineKeyboard} from 'grammy'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'

export async function waitForInvoice(conversation: BotConversation, ctx: ConversationContext) {
  const keyboard = new InlineKeyboard().add({callback_data: 'cancel', text: ctx.t('button.cancel')})
  const message = await ctx.reply(ctx.t('wait-for-invoice'), {reply_markup: keyboard})
  const msgContext = await conversation.waitForHears(/(lnbc[a-z0-9]+)/, {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      if (ctx.update.message?.text) await ctx.reply(ctx.t('wait-for-invoice.invalid'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))
  return msgContext.match[1]!
}
