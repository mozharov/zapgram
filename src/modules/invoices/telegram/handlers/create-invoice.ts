import type {BotContext} from '@telegram/context.js'
import {creatingInvoice} from '../conversations/creating-invoice.js'

export const createInvoiceCallback = async (ctx: BotContext) => {
  await ctx.conversation.enter(creatingInvoice.name)
}
