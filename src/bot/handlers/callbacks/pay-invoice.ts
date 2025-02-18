import type {BotContext} from '../../context.js'
import {payingInvoice} from '../../conversations/paying-invoice.js'

export const payInvoiceCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await ctx.conversation.enter(payingInvoice.name)
}
