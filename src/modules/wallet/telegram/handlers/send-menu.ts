import {sendingPayment} from '@modules/tipping/telegram/sending-payment.js'
import type {BotContext} from '@telegram/context.js'

export const sendMenuCallback = async (ctx: BotContext) => {
  await ctx.conversation.enter(sendingPayment.name)
}
