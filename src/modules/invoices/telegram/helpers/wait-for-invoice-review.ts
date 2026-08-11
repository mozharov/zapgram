import {msatsToSats} from '@core/money/sats.js'
import type {Invoice} from '@getalby/lightning-tools'
import {getPendingInvoiceBy} from '@modules/invoices/repository.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'

export async function waitForInvoiceReview(
  conversation: BotConversation,
  ctx: ConversationContext,
  invoice: Invoice,
  isInternalWallet: boolean,
) {
  const timestamp = await conversation.external(() => Date.now())
  const payCallback = `pay:${timestamp}` // avoid pay wrong invoice
  const keyboard = new InlineKeyboard()
    .add({
      callback_data: payCallback,
      text: ctx.t('button.confirm-pay-invoice'),
    })
    .add({
      callback_data: staticCallback.cancel,
      text: ctx.t('button.cancel'),
    })

  let satsFee: number | 'no' = 'no'
  if (isInternalWallet) {
    const internalInvoice = await getPendingInvoiceBy({paymentRequest: invoice.paymentRequest})
    if (internalInvoice) satsFee = 0
    else satsFee = msatsToSats(await ctx.user.wallet.getFeeReserve(invoice.paymentRequest))
  }
  const [usdSuffix = '', feeUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi, satsFee === 'no' ? 0 : satsFee]),
  )
  const html = ctx.t('wait-for-invoice-review', {
    amount: invoice.satoshi,
    usdSuffix,
    fee: satsFee,
    feeUsdSuffix: satsFee === 'no' ? '' : feeUsdSuffix,
    description: invoice.description ?? '',
    hasDescription: (!!invoice.description).toString(),
    createdDate: invoice.createdDate,
    expiryDate: invoice.expiryDate ?? 'no',
    hasExpired: invoice.hasExpired().toString(),
  })
  const message = await ctx.reply(html, {
    reply_markup: invoice.hasExpired() ? undefined : keyboard,
    link_preview_options: {is_disabled: true},
  })

  if (invoice.hasExpired()) return conversation.halt()

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
      return
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    await next.reply(next.t('conversation-state.use-buttons'))
  }
}
