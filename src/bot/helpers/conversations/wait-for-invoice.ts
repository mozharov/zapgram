import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
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
  const invoice = msgContext.match[1]
  if (invoice === undefined) throw new Error('Invoice match missing')
  return invoice
}
