import {recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {
  fetchLnurlPay,
  type LnurlPayQuote,
  lnurlFailureCode,
  requestLnurlInvoice,
} from '@infra/lightning/lnurl-pay.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  disabledLinkPreview,
  joinWizardHtml,
  showHostOrReply,
} from '@telegram/helpers/conversation-host.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {InlineKeyboard} from 'grammy'
import {lnurlPayeeHtml} from '../lnurl-payee.js'
import {payingInvoice} from './paying-invoice.js'

/**
 * Pay a lightning address or LNURL by turning it into a bolt11, then the existing
 * invoice confirmation. The callback invoice is checked before that screen: a bad
 * amount, a bad description hash, or a failed recipient response never reaches pay.
 */
export async function payingLnurl(
  conversation: BotConversation,
  ctx: ConversationContext,
  target: string,
) {
  const request = recognizePaymentRequest(target)
  if (!request || request.kind === 'bolt11') {
    await refuse(ctx, 'bad-response')
    return conversation.halt()
  }

  await ctx.replyWithChatAction('typing')
  // The code comes back as data. A thrown LnurlPayError does not survive
  // conversation.external, and the refusal would collapse into "unexpected response".
  const loaded = await conversation.external(async () => {
    try {
      const quote = await fetchLnurlPay(request)
      ctx.log.info(
        {kind: request.kind, minSats: quote.minSats, maxSats: quote.maxSats},
        'LNURL pay request loaded',
      )
      return {ok: true as const, quote}
    } catch (error) {
      const code = lnurlFailureCode(error)
      ctx.log.info({kind: request.kind, code}, 'LNURL pay request refused')
      return {ok: false as const, code}
    }
  })
  if (!loaded.ok) {
    await refuse(ctx, loaded.code)
    return conversation.halt()
  }
  const quote: LnurlPayQuote = loaded.quote
  const payee = lnurlPayeeHtml(
    quote.description,
    quote.identifier || (request.kind === 'lightning-address' ? request.value : ''),
  )

  const html = joinWizardHtml(
    ctx.t('lnurl-pay-amount', {
      min: quote.minSats,
      max: quote.maxSats,
      exact: quote.minSats === quote.maxSats ? 'yes' : 'no',
    }),
    payee,
  )
  const message = await showHostOrReply(ctx, html, cancelKeyboard(ctx))
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-lnurl-amount'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let sats: number | undefined
  for (;;) {
    const next = await waitForStepInput(conversation, prompt, {intercept: 'all'})
    if (!next) continue
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const text = next.message?.text?.trim()
    const entered = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(entered) || entered < quote.minSats || entered > quote.maxSats) {
      await replyWithConversationTempMessage(
        conversation,
        next,
        next.t('lnurl-pay-amount.invalid', {min: quote.minSats, max: quote.maxSats}),
      )
      continue
    }
    await clearPromptControls(conversation, prompt)
    await deleteMessageSafely(next)
    sats = entered
    break
  }
  if (sats === undefined) return conversation.halt()
  const amount = sats

  await ctx.replyWithChatAction('typing')
  const invoiced = await conversation.external(async () => {
    try {
      const invoice = await requestLnurlInvoice(quote, amount)
      ctx.log.info({kind: request.kind, sats: amount}, 'LNURL invoice accepted')
      return {ok: true as const, invoice}
    } catch (error) {
      const code = lnurlFailureCode(error)
      ctx.log.info({kind: request.kind, sats: amount, code}, 'LNURL invoice refused')
      return {ok: false as const, code}
    }
  })
  if (!invoiced.ok) {
    await refuse(ctx, invoiced.code)
    return conversation.halt()
  }
  const bolt11 = invoiced.invoice

  // Confirmation and the wallet pay live here. This call does not pay by itself.
  // The payee stays on that screen: a hash-only invoice has no description of its own,
  // and the pasted address is deleted with the offer.
  await payingInvoice(conversation, ctx, bolt11, payee)
}

function cancelKeyboard(ctx: ConversationContext): InlineKeyboard {
  return new InlineKeyboard([
    [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
  ])
}

async function refuse(ctx: ConversationContext, reason: string): Promise<void> {
  await ctx.reply(ctx.t('lnurl-pay-failed', {reason}), disabledLinkPreview)
}
