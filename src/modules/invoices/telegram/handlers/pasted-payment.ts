import {recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {replyWithPastedPaymentOffer, takePastedPayment} from '@telegram/helpers/pasted-payment.js'
import type {NextFunction} from 'grammy'
import {payingInvoice} from '../conversations/paying-invoice.js'

/**
 * Private text no wizard claimed. A whole-message bolt11 starts the existing pay-invoice
 * flow (same as the lnbc hears handler, plus case and a `lightning:` prefix). A Lightning
 * address or LNURL has no settlement of its own, so the offer is shown and Pay opens that
 * same flow at the invoice field.
 */
export async function pastedPaymentText(ctx: BotContext, next: NextFunction): Promise<void> {
  const text = ctx.message?.text
  if (!text) return next()
  const request = recognizePaymentRequest(text)
  if (!request) return next()
  if (request.kind === 'bolt11') {
    await ctx.conversation.enter(payingInvoice.name, request.value)
    return
  }
  await replyWithPastedPaymentOffer(ctx, request)
}

export async function payPastedCallback(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id
  const data = ctx.callbackQuery?.data ?? ''
  const {token} = payPastedRoute.parse(data)
  const request = userId === undefined ? undefined : takePastedPayment(userId, token)
  if (!request) {
    await deleteMessageSafely(ctx)
    await ctx.answerCallbackQuery({text: ctx.t('callback-answer.unknown')})
    return
  }
  await ctx.answerCallbackQuery()
  // Only a bolt11 can skip the paste step. Address and LNURL open the same flow
  // the Pay Invoice button does — this bot does not resolve them into an invoice.
  if (request.kind === 'bolt11') {
    await ctx.conversation.enter(payingInvoice.name, request.value)
    return
  }
  await ctx.conversation.enter(payingInvoice.name)
}

/** Back outside a wizard just dismisses the offer. Inside a wizard the step handles it. */
export async function payPastedBackCallback(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id
  const data = ctx.callbackQuery?.data ?? ''
  const {token} = payPastedBackRoute.parse(data)
  if (userId !== undefined) takePastedPayment(userId, token)
  await deleteMessageSafely(ctx)
  await ctx.answerCallbackQuery({text: ctx.t('callback-answer.pasted-payment-back')})
}
