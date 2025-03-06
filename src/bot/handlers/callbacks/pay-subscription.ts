import {getSubscriptionPayment} from '../../../models/subscription-payment.js'
import type {BotContext} from '../../context.js'
import {CallbackQueryContext} from 'grammy'
import {NWCConnectionError} from '../../errors/nwc-connection.js'

export const paySubscriptionCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {paymentId, from} = parseMatch(ctx.match)
  const subscriptionPayment = await getSubscriptionPayment(paymentId)
  if (!subscriptionPayment) return ctx.editMessageText(ctx.t('subscription-invoice.expired'))

  if (from === 'wallet') await ctx.user.wallet.payInvoice(subscriptionPayment.paymentRequest)
  else if (!ctx.user.nwc) throw new NWCConnectionError()
  else await ctx.user.nwc.payInvoice(subscriptionPayment.paymentRequest)

  await ctx.deleteMessage()
  return ctx.reply(ctx.t('subscription-invoice.paid-from-balance'))
}

function parseMatch(match: string | RegExpMatchArray) {
  const [, paymentId, from] = match
  return {paymentId: paymentId!, from: from! as 'wallet' | 'nwc'}
}
