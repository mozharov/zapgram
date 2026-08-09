import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {msatsToSats} from '@core/money/sats.js'
import {claimAndNotifyPaidInvoice} from '@modules/invoices/claim-and-notify-paid.js'
import {
  claimPendingInvoiceByPaymentRequest,
  getPendingInvoiceBy,
} from '@modules/invoices/repository.js'
import {waitForInvoice} from '@modules/invoices/telegram/helpers/wait-for-invoice.js'
import {waitForInvoiceReview} from '@modules/invoices/telegram/helpers/wait-for-invoice-review.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function payingInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  lnInvoice?: string,
) {
  await ctx.reply(ctx.t('paying-invoice'))
  const invoice = decodeInvoice(lnInvoice ?? (await waitForInvoice(conversation, ctx)))
  ctx.log.debug({invoice}, 'Decoded invoice')

  const wallet = await waitForWallet(conversation, ctx, {
    requiredSats: invoice.satoshi,
    flow: 'pay_invoice',
  })
  const isInternalWallet = wallet === 'internal'
  await waitForInvoiceReview(conversation, ctx, invoice, isInternalWallet)
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

  await ctx.reply(
    ctx.t('paying-invoice.paid', {
      amount: invoice.satoshi,
      fee: msatsToSats(feesPaid),
      total: msatsToSats(invoice.millisatoshi + feesPaid),
    }),
  )
  await replyWithWallet(ctx)
}
