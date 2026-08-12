import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {msatsToSats} from '@core/money/sats.js'
import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {
  claimPendingInvoiceByPaymentRequest,
  getPendingInvoiceBy,
} from '@modules/invoices/repository.js'
import {
  invoiceReviewHtml,
  visibleInvoiceDescription,
} from '@modules/invoices/telegram/helpers/invoice-review.js'
import {waitForInvoice} from '@modules/invoices/telegram/helpers/wait-for-invoice.js'
import {waitForInvoiceReview} from '@modules/invoices/telegram/helpers/wait-for-invoice-review.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {editHostWithSendMenu} from '@modules/wallet/telegram/messages/send-menu.js'
import {editHostWithWallet, replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  disabledLinkPreview,
  ensureHost,
  hostFromCallback,
  joinWizardHtml,
} from '@telegram/helpers/conversation-host.js'
import {copyableText} from '@telegram/helpers/copy-text.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function payingInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  lnInvoice?: string,
) {
  const title = ctx.t('paying-invoice')
  let host: ConversationHost | undefined = hostFromCallback(ctx)
  const restoreParent = async (target?: ConversationHost) => {
    const dest = target ?? host
    if (!dest) return
    if (lnInvoice) await editHostWithWallet(ctx, dest)
    else await editHostWithSendMenu(ctx, dest)
  }

  if (!lnInvoice) {
    host ??= await ensureHost(ctx, joinWizardHtml(title, ctx.t('wait-for-invoice')))
  }
  const paymentRequest =
    lnInvoice ??
    (await waitForInvoice(conversation, ctx, {
      host,
      html: joinWizardHtml(title, ctx.t('wait-for-invoice')),
      onCancel: restoreParent,
    }))
  const invoice = decodeInvoice(paymentRequest)
  if (lnInvoice) await deleteMessageSafely(ctx)
  ctx.log.debug(
    {paymentHash: invoice.paymentHash, sats: invoice.satoshi, expiryDate: invoice.expiryDate},
    'Decoded invoice to pay',
  )

  const [previewUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi]),
  )
  const details = invoiceReviewHtml(ctx, invoice, {
    usdSuffix: previewUsdSuffix,
    fee: 'no',
    feeUsdSuffix: '',
  })

  if (invoice.hasExpired()) {
    await waitForInvoiceReview(conversation, ctx, invoice, true, {
      host,
      prefixHtml: host ? title : undefined,
      onCancel: restoreParent,
    })
    return
  }

  const selection = await waitForWallet(conversation, ctx, {
    requiredSats: invoice.satoshi,
    flow: 'pay_invoice',
    host,
    html: joinWizardHtml(details, ctx.t('wait-for-wallet.pay-invoice')),
    copyText: copyableText(invoice.paymentRequest),
    onCancel: restoreParent,
  })
  const {wallet} = selection
  host = host ?? selection.host
  const isInternalWallet = wallet === 'internal'
  if (wallet === 'nwc' && !ctx.user.nwc) throw new NWCConnectionError()
  await ctx.replyWithChatAction('typing')

  // Snapshot before pay: a concurrent LNbits webhook may claim the row the instant pay settles.
  const isInternalRecipient = Boolean(
    await getPendingInvoiceBy({paymentRequest: invoice.paymentRequest}),
  )

  let feesPaid = 0
  if (isInternalWallet) {
    const payment = await ctx.user.wallet.payInvoice(invoice.paymentRequest)
    feesPaid = payment.fee < 0 ? -payment.fee : 0
  } else {
    if (!ctx.user.nwc) throw new NWCConnectionError()
    await ctx.user.nwc.payInvoice(invoice.paymentRequest)
    const lookupResponse = await ctx.user.nwc.lookupInvoice(invoice.paymentRequest)
    feesPaid = lookupResponse.fees_paid
  }

  // Past the last `conversation.wait()`, so this line is written once and not on every replay.
  ctx.log.info(
    {
      paymentHash: invoice.paymentHash,
      sats: invoice.satoshi,
      feeMsats: feesPaid,
      source: wallet,
      internalRecipient: isInternalRecipient,
    },
    'Lightning invoice paid',
  )

  // Claim-or-skip: webhook / cron may already have notified the recipient.
  await claimAndNotifyPaidInvoice(
    () => claimPendingInvoiceByPaymentRequest(invoice.paymentRequest),
    'internal_pay',
  )

  getRuntime().posthog?.capture({
    event: 'invoice_paid',
    properties: {
      amount_sats: invoice.satoshi,
      fee_sats: msatsToSats(feesPaid),
      wallet_type: wallet,
      is_internal_recipient: isInternalRecipient,
    },
  })

  // Best-effort voluntary platform donation — never blocks the invoice pay.
  await getRuntime().donationCollect.tryCollect({
    userId: ctx.user.id,
    baseAmountSats: invoice.satoshi,
    kind: 'invoice',
    preferredRail: isInternalWallet ? 'internal' : 'nwc',
    nwc: isInternalWallet ? undefined : ctx.user.nwc,
    nwcUrl: ctx.user.nwcUrl,
    user: ctx.user,
  })

  if (!host) throw new Error('Paying invoice finished without a host message')

  const fee = msatsToSats(feesPaid)
  const total = msatsToSats(invoice.millisatoshi + feesPaid)
  const description = visibleInvoiceDescription(invoice.description)
  const [usdSuffix = '', feeUsdSuffix = '', totalUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi, fee, total]),
  )
  const paidHtml = ctx.t('paying-invoice.paid', {
    amount: invoice.satoshi,
    usdSuffix,
    fee,
    feeUsdSuffix,
    total,
    totalUsdSuffix,
    wallet,
    description,
    hasDescription: (!!description).toString(),
    invoice: invoice.paymentRequest,
  })
  await ctx.api.editMessageText(host.chatId, host.messageId, paidHtml, {
    reply_markup: paidKeyboard(ctx, invoice.paymentRequest),
    ...disabledLinkPreview,
  })
  await replyWithWallet(ctx)
}

function paidKeyboard(ctx: ConversationContext, paymentRequest: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const copyText = copyableText(paymentRequest)
  if (copyText) keyboard.copyText(ctx.t('button.copy-invoice'), copyText)
  return keyboard
}
