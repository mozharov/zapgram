import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import type {CallbackQueryContext} from 'grammy'
import {getSubscriptionPayment} from '../../../models/subscription-payment.js'
import type {BotContext} from '../../context.js'

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
  if (typeof match === 'string') throw new Error('Invalid callback match')
  const paymentId = match[1]
  const from = match[2]
  if (paymentId === undefined || (from !== 'wallet' && from !== 'nwc')) {
    throw new Error('Invalid callback match')
  }
  return {paymentId, from}
}
