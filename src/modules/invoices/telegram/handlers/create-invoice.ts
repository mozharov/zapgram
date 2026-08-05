import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {creatingInvoice} from '../conversations/creating-invoice.js'

export const createInvoiceCallback = async (ctx: BotContext) => {
  await deleteMessageSafely(ctx)
  await ctx.conversation.enter(creatingInvoice.name)
}
