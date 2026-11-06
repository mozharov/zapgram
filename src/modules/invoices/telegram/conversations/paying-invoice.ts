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
import {editHostWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {payPastedRoute} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  disabledLinkPreview,
  editHost,
  ensureHost,
  hostFromCallback,
  joinWizardHtml,
} from '@telegram/helpers/conversation-host.js'
import {copyableText} from '@telegram/helpers/copy-text.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {closeLivingMenu} from '@telegram/helpers/living-menu.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export async function payingInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  lnInvoice?: string,
  options?: {
    /** Shown above the invoice review. BOLT11 leaves this unset. */
    reviewPrefix?: string
    /**
     * Edit this message for the review and the receipt. A second living menu would
     * be adopted again on replay and delete the receipt the payment just wrote.
     */
    host?: ConversationHost
    /** LNURL invoices can expire while the confirm button is on screen. */
    recheckExpiry?: boolean
  },
) {
  const reviewPrefix = options?.reviewPrefix
  const title = ctx.t('paying-invoice')
  // Pay on a pasted bolt11 arrives as a callback on that offer. The offer is not the
  // wizard host: the invoice skips straight to review, the offer is removed, and the
  // screen is a new message. The step the user left must not keep a live Cancel button.
  // An explicit host (the LNURL amount screen) is that one message instead.
  const fromPastedPay = payPastedRoute.pattern.test(ctx.callbackQuery?.data ?? '')
  let host: ConversationHost | undefined = options?.host ?? hostFromCallback(ctx)
  if (!options?.host && (lnInvoice || fromPastedPay)) host = undefined
  const restoreParent = async (target?: ConversationHost) => {
    const dest = target ?? host
    if (!dest) return
    await editHostWithWallet(ctx, dest)
  }

  if (!lnInvoice && !fromPastedPay) {
    host ??= await ensureHost(ctx, joinWizardHtml(title, ctx.t('wait-for-invoice')))
  }
  const paymentRequest =
    lnInvoice ??
    (await waitForInvoice(conversation, ctx, {
      host,
      html: joinWizardHtml(title, ctx.t('wait-for-invoice')),
      onCancel: restoreParent,
    }))
  let invoice: ReturnType<typeof decodeInvoice>
  try {
    invoice = decodeInvoice(paymentRequest)
  } catch {
    if (!lnInvoice) throw new Error('Validated invoice could not be decoded')
    await replyWithConversationTempMessage(conversation, ctx, ctx.t('wait-for-invoice.invalid'))
    return conversation.halt()
  }
  // A pasted bolt11 is the message under the cursor. LNURL already deleted the amount
  // text and passes the amount screen as `host`; deleting `ctx` would target that
  // screen once the update is the confirm click.
  if (lnInvoice && !fromPastedPay && !options?.host) await deleteMessageSafely(ctx)
  if (fromPastedPay) await deleteRepliedInvoice(ctx)
  ctx.log.debug(
    {paymentHash: invoice.paymentHash, sats: invoice.satoshi, expiryDate: invoice.expiryDate},
    'Decoded invoice to pay',
  )

  const [previewUsdSuffix = ''] = await conversation.external(() =>
    usdSuffixesForSats([invoice.satoshi]),
  )
  const details = joinWizardHtml(
    reviewPrefix,
    invoiceReviewHtml(ctx, invoice, {
      usdSuffix: previewUsdSuffix,
      fee: 'no',
      feeUsdSuffix: '',
    }),
  )

  // Freeze the open-time answer for an LNURL invoice. A live check here would take a
  // different branch when the confirm click replays the conversation after expiry,
  // and grammY would throw instead of reaching the click. The pay itself is refused
  // after that click, below.
  const expiredAtOpen = options?.recheckExpiry
    ? await conversation.external(() => invoice.hasExpired())
    : invoice.hasExpired()
  if (expiredAtOpen) {
    await waitForInvoiceReview(conversation, ctx, invoice, true, {
      host,
      prefixHtml: joinWizardHtml(reviewPrefix, host ? title : undefined) || undefined,
      onCancel: restoreParent,
    })
    return
  }

  const selection = await waitForWallet(conversation, ctx, {
    requiredSats: invoice.satoshi,
    flow: 'pay_invoice',
    host,
    html: joinWizardHtml(details, ctx.t('wait-for-wallet.pay-invoice')),
    soleWallet: {
      html: wallet => joinWizardHtml(details, ctx.t(`wait-for-wallet.pay-invoice-${wallet}`)),
      buttonText: ctx.t('button.confirm-pay-invoice'),
      actionLabel: ctx.t('conversation-action.confirm-invoice-payment'),
    },
    copyText: copyableText(invoice.paymentRequest),
    onCancel: restoreParent,
  })
  const {wallet} = selection
  host = host ?? selection.host
  if (options?.recheckExpiry && invoice.hasExpired()) {
    const expiredHtml = joinWizardHtml(
      reviewPrefix,
      invoiceReviewHtml(ctx, invoice, {
        usdSuffix: previewUsdSuffix,
        fee: 'no',
        feeUsdSuffix: '',
      }),
    )
    // The confirm button was on this message. Take it off so the expired invoice
    // cannot be clicked again; the conversation is halted either way.
    const expiredKeyboard = new InlineKeyboard()
    if (host) await editHost(ctx, host, expiredHtml, expiredKeyboard)
    else await ctx.reply(expiredHtml, {reply_markup: expiredKeyboard, ...disabledLinkPreview})
    return conversation.halt()
  }
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
  // The wizard's own screen becomes the receipt, so no extra message is sent, and it keeps the
  // open-menu row instead of vanishing under the wallet screen the next `showLivingMenu` would send.
  await closeLivingMenu(
    ctx,
    host.messageId,
    markup =>
      ctx.api.editMessageText(host.chatId, host.messageId, paidHtml, {
        reply_markup: markup,
        ...disabledLinkPreview,
      }),
    paidKeyboard(ctx, invoice.paymentRequest),
  )
}

async function deleteRepliedInvoice(ctx: ConversationContext): Promise<void> {
  const message = ctx.callbackQuery?.message
  if (!message || !('reply_to_message' in message)) return
  const replied = message.reply_to_message
  if (!replied || !('message_id' in replied) || ctx.chat?.id === undefined) return
  await ctx.api.deleteMessage(ctx.chat.id, replied.message_id).catch(() => undefined)
}

function paidKeyboard(ctx: ConversationContext, paymentRequest: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const copyText = copyableText(paymentRequest)
  if (copyText) keyboard.copyText(ctx.t('button.copy-invoice'), copyText)
  return keyboard
}
