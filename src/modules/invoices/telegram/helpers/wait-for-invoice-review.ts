import {msatsToSats} from '@core/money/sats.js'
import type {Invoice} from '@getalby/lightning-tools'
import {getPendingInvoiceBy} from '@modules/invoices/repository.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
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
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {copyableText} from '@telegram/helpers/copy-text.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {invoiceReviewHtml} from './invoice-review.js'

export async function waitForInvoiceReview(
  conversation: BotConversation,
  ctx: ConversationContext,
  invoice: Invoice,
  isInternalWallet: boolean,
  opts?: {
    host?: ConversationHost
    prefixHtml?: string
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
): Promise<ConversationHost> {
  const timestamp = await conversation.external(() => Date.now())
  const payCallback = `pay:${timestamp}` // avoid pay wrong invoice
  const keyboard = reviewKeyboard(ctx, invoice, payCallback)

  let satsFee: number | 'no' = 'no'
  if (isInternalWallet) {
    const internalInvoice = await getPendingInvoiceBy({paymentRequest: invoice.paymentRequest})
    if (internalInvoice) satsFee = 0
    else satsFee = msatsToSats(await ctx.user.wallet.getFeeReserve(invoice.paymentRequest))
  }
  const [usdSuffix = '', feeUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi, satsFee === 'no' ? 0 : satsFee]),
  )
  const html = joinWizardHtml(
    opts?.prefixHtml,
    invoiceReviewHtml(ctx, invoice, {
      usdSuffix,
      fee: satsFee,
      feeUsdSuffix: satsFee === 'no' ? '' : feeUsdSuffix,
    }),
  )
  const message = await showHostOrReply(ctx, html, keyboard, opts?.host)

  if (invoice.hasExpired()) return conversation.halt()

  const reviewHost = {chatId: message.chat.id, messageId: message.message_id}
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.confirm-invoice-payment'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    if (next.callbackQuery?.data === payCallback && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, prompt)
      return reviewHost
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (opts?.onCancel) await opts.onCancel(opts.host ?? reviewHost)
      else await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    if (opts?.onCancel) await opts.onCancel(opts.host ?? reviewHost)
    else await deactivatePrompt(conversation, prompt, cancelled)
    return conversation.halt()
  }
}

function reviewKeyboard(
  ctx: ConversationContext,
  invoice: Invoice,
  payCallback: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (invoice.hasExpired()) return keyboard

  const copyText = copyableText(invoice.paymentRequest)
  if (copyText) keyboard.copyText(ctx.t('button.copy-invoice'), copyText)
  keyboard.row(
    {callback_data: payCallback, text: ctx.t('button.confirm-pay-invoice')},
    {callback_data: staticCallback.cancel, text: ctx.t('button.cancel')},
  )
  return keyboard
}
