import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {msatsToSats} from '@core/money/sats.js'
import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {
  claimPendingInvoiceByPaymentRequest,
  getPendingInvoiceBy,
} from '@modules/invoices/repository.js'
import {invoiceReviewHtml} from '@modules/invoices/telegram/helpers/invoice-review.js'
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
    const reviewHost = await waitForInvoiceReview(conversation, ctx, invoice, true, {
      host,
      prefixHtml: host ? title : undefined,
      onCancel: restoreParent,
    })
    host = host ?? reviewHost
    return
  }

  if (ctx.user.nwc) {
    host ??= await ensureHost(ctx, joinWizardHtml(title, details))
  }

  const {wallet, nwcBalanceError} = await waitForWallet(conversation, ctx, {
    requiredSats: invoice.satoshi,
    flow: 'pay_invoice',
    host,
    html: host ? joinWizardHtml(title, details, ctx.t('wait-for-wallet')) : undefined,
    copyText: copyableText(invoice.paymentRequest),
    onCancel: restoreParent,
  })
  const isInternalWallet = wallet === 'internal'
  const selectedWallet = ctx.user.nwc
    ? wallet === 'nwc'
      ? ctx.t('wait-for-wallet.nwc')
      : ctx.t('wait-for-wallet.internal')
    : undefined
  const nwcNote = nwcBalanceError ? ctx.t('wait-for-wallet.nwc-unreachable') : undefined
  const reviewHost = await waitForInvoiceReview(conversation, ctx, invoice, isInternalWallet, {
    host,
    prefixHtml: joinWizardHtml(title, selectedWallet, nwcNote),
    onCancel: restoreParent,
  })
  host = host ?? reviewHost
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

  const fee = msatsToSats(feesPaid)
  const total = msatsToSats(invoice.millisatoshi + feesPaid)
  const [usdSuffix = '', feeUsdSuffix = '', totalUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi, fee, total]),
  )
  await ctx.api.editMessageText(
    host.chatId,
    host.messageId,
    joinWizardHtml(
      title,
      selectedWallet,
      ctx.t('paying-invoice.paid', {
        amount: invoice.satoshi,
        usdSuffix,
        fee,
        feeUsdSuffix,
        total,
        totalUsdSuffix,
      }),
    ),
    disabledLinkPreview,
  )
  await replyWithWallet(ctx)
}
