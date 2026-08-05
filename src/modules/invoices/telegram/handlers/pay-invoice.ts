import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {payingInvoice} from '../conversations/paying-invoice.js'

export const payInvoiceCallback = async (ctx: BotContext) => {
  await deleteMessageSafely(ctx)
  await ctx.conversation.enter(payingInvoice.name)
}
