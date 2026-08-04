import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {getSubscriptionPayment} from '@modules/subscriptions/payment-repository.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {paySubscriptionRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const paySubscriptionCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {paymentId, from} = paySubscriptionRoute.parse(ctx.match)
  const subscriptionPayment = await getSubscriptionPayment(paymentId)
  if (!subscriptionPayment) return ctx.editMessageText(ctx.t('subscription-invoice.expired'))

  if (from === 'wallet') await ctx.user.wallet.payInvoice(subscriptionPayment.paymentRequest)
  else if (!ctx.user.nwc) throw new NWCConnectionError()
  else await ctx.user.nwc.payInvoice(subscriptionPayment.paymentRequest)

  captureBotEvent(
    getRuntime().posthog,
    'subscription_paid',
    {
      payment_method: from,
      amount_sats: subscriptionPayment.price,
      chat_id: subscriptionPayment.chatId,
      payment_id: subscriptionPayment.id,
    },
    {chatId: subscriptionPayment.chatId},
  )

  await ctx.deleteMessage()
  return ctx.reply(ctx.t('subscription-invoice.paid-from-balance'))
}
