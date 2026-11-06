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
  type ConversationHost,
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
import {lnurlPayeeParts} from '../lnurl-payee.js'
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
  opts?: {
    host?: ConversationHost
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
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
  const entered =
    request.kind === 'lightning-address' ? request.value : (quote.metadataHosts[0] ?? '')
  const enteredKind = request.kind === 'lightning-address' ? 'address' : 'host'

  const html = joinWizardHtml(
    ctx.t('lnurl-pay-amount', {
      min: quote.minSats,
      max: quote.maxSats,
      exact: quote.minSats === quote.maxSats ? 'yes' : 'no',
    }),
    payeeHtml(ctx, {
      entered,
      enteredKind,
      hosts: quote.metadataHosts,
      serviceText: quote.serviceText,
    }),
  )
  // This message is the only living menu for the payment. The review and the receipt
  // edit it. A second showLivingMenu would be adopted again when the confirm click
  // replays this function, and that adoption deletes the receipt through bot.api.
  // The send wizard passes its own screen so we edit that instead of opening another.
  const message = await showHostOrReply(ctx, html, cancelKeyboard(ctx), opts?.host)
  const screen = {chatId: message.chat.id, messageId: message.message_id}
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
      if (opts?.onCancel) {
        await opts.onCancel(opts.host ?? {chatId: prompt.chatId, messageId: prompt.messageId})
      } else await deactivatePrompt(conversation, prompt, cancelled)
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
      return {ok: true as const, bolt11: invoice.bolt11, callbackHosts: invoice.callbackHosts}
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

  const payee = payeeHtml(ctx, {
    entered,
    enteredKind,
    hosts: [...quote.metadataHosts, ...invoiced.callbackHosts],
    serviceText: quote.serviceText,
  })
  // Confirmation and the wallet pay edit `screen`. Nothing is paid before that button.
  await payingInvoice(conversation, ctx, invoiced.bolt11, {
    reviewPrefix: payee,
    host: screen,
    recheckExpiry: true,
  })
}

function payeeHtml(
  ctx: ConversationContext,
  view: {entered: string; enteredKind: 'address' | 'host'; hosts: string[]; serviceText: string},
): string {
  const parts = lnurlPayeeParts(view)
  const who =
    view.enteredKind === 'address'
      ? ctx.t('lnurl-pay-address', {address: parts.entered})
      : ctx.t('lnurl-pay-host', {host: parts.entered})
  return joinWizardHtml(
    who,
    parts.route ? ctx.t('lnurl-pay-route', {route: parts.route}) : undefined,
    parts.invoiceHost ? ctx.t('lnurl-pay-invoice-from', {host: parts.invoiceHost}) : undefined,
    parts.note ? ctx.t('lnurl-pay-service-note', {note: parts.note}) : undefined,
  )
}

function cancelKeyboard(ctx: ConversationContext): InlineKeyboard {
  return new InlineKeyboard([
    [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
  ])
}

async function refuse(ctx: ConversationContext, reason: string): Promise<void> {
  await ctx.reply(ctx.t('lnurl-pay-failed', {reason}), disabledLinkPreview)
}
