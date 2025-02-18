import type {HearsContext} from 'grammy'
import type {BotContext} from '../../context.js'
import {payingInvoice} from '../../conversations/paying-invoice.js'

export const lnInvoiceHears = async (ctx: HearsContext<BotContext>) => {
  const lnInvoice = ctx.match[1]
  await ctx.conversation.enter(payingInvoice.name, lnInvoice)
}
