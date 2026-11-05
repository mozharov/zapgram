import {recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {
  bolt11MatchingToken,
  commitPastedPay,
  releasePastedPay,
  repliedText,
  replyWithUnsupportedPayment,
  reservePastedPay,
} from '@telegram/helpers/pasted-payment.js'
import type {NextFunction} from 'grammy'
import {payingInvoice} from '../conversations/paying-invoice.js'

/**
 * Private text no wizard claimed. A whole-message bolt11 starts the existing pay-invoice
 * flow (same as the lnbc hears handler, plus case and a `lightning:` prefix). A Lightning
 * address or LNURL is named and left unpaid — there is no button, and no invoice dialog.
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
  await replyWithUnsupportedPayment(ctx)
}

export async function payPastedCallback(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id
  const {token} = payPastedRoute.parse(ctx.callbackQuery?.data ?? '')
  // Before any await. Two taps otherwise both see "no payment in progress" and both enter.
  if (userId === undefined || !reservePastedPay(userId, token)) {
    await ctx.answerCallbackQuery()
    return
  }
  try {
    if ((await ctx.conversation.active(payingInvoice.name)) > 0) {
      commitPastedPay(userId, token)
      await ctx.answerCallbackQuery()
      return
    }
    const bolt11 = bolt11MatchingToken(userId, token, repliedText(ctx))
    if (!bolt11) {
      releasePastedPay(userId, token)
      await deleteMessageSafely(ctx)
      await ctx.answerCallbackQuery({text: ctx.t('callback-answer.pasted-payment-missing')})
      return
    }
    await ctx.answerCallbackQuery()
    await ctx.conversation.enter(payingInvoice.name, bolt11)
    commitPastedPay(userId, token)
  } catch (error) {
    releasePastedPay(userId, token)
    throw error
  }
}

/** Back outside a wizard just dismisses the offer. Inside a wizard the step handles it. */
export async function payPastedBackCallback(ctx: BotContext): Promise<void> {
  payPastedBackRoute.parse(ctx.callbackQuery?.data ?? '')
  await deleteMessageSafely(ctx)
  await ctx.answerCallbackQuery({text: ctx.t('callback-answer.pasted-payment-back')})
}
