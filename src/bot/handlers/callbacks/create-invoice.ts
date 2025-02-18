import type {BotContext} from '../../context.js'
import {creatingInvoice} from '../../conversations/creating-invoice.js'

export const createInvoiceCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await ctx.conversation.enter(creatingInvoice.name)
}
