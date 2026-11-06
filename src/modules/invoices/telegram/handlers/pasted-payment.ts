import {recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {
  answerOfferClick,
  bolt11MatchingToken,
  claimPastedOffer,
  releasePastedPay,
  repliedText,
  replyWithUnsupportedPayment,
  reservePastedPay,
  takePastedPayHandoff,
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
  if (userId === undefined) {
    await answerOfferClick(ctx)
    return
  }
  // Inside a wizard the conversation already deleted the offer on this click.
  // A click with no wizard still has to win that delete itself.
  if (!takePastedPayHandoff(ctx)) {
    const claim = await claimPastedOffer(ctx)
    if (claim === 'retry') {
      await answerOfferClick(ctx, ctx.t('callback-answer.pasted-payment-retry'))
      return
    }
    if (claim !== 'claimed') {
      await answerOfferClick(ctx, ctx.t('callback-answer.pasted-payment-stale'))
      return
    }
  }
  if (!reservePastedPay(userId, token)) {
    await answerOfferClick(ctx)
    return
  }
  try {
    // Still open from an earlier click. Do not start a second one.
    if ((await ctx.conversation.active(payingInvoice.name)) > 0) {
      await answerOfferClick(ctx)
      return
    }
    const bolt11 = bolt11MatchingToken(userId, token, repliedText(ctx))
    if (!bolt11) {
      await answerOfferClick(ctx, ctx.t('callback-answer.pasted-payment-missing'))
      return
    }
    // The delete already claimed the offer. A failed answer must not skip payment
    // and must not be reported as "this offer is no longer active".
    await answerOfferClick(ctx)
    await ctx.conversation.enter(payingInvoice.name, bolt11)
  } finally {
    releasePastedPay(userId, token)
  }
}

/** Back outside a wizard just dismisses the offer. Inside a wizard the step handles it. */
export async function payPastedBackCallback(ctx: BotContext): Promise<void> {
  payPastedBackRoute.parse(ctx.callbackQuery?.data ?? '')
  await deleteMessageSafely(ctx)
  await ctx.answerCallbackQuery({text: ctx.t('callback-answer.pasted-payment-closed')})
}
