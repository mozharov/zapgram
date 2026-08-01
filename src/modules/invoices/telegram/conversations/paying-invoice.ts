import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {msatsToSats} from '@core/money/sats.js'
import {notifyInvoicePaid} from '@modules/invoices/notify-invoice-paid.js'
import {deletePendingInvoice, getPendingInvoiceBy} from '@modules/invoices/repository.js'
import {waitForInvoice} from '@modules/invoices/telegram/helpers/wait-for-invoice.js'
import {waitForInvoiceReview} from '@modules/invoices/telegram/helpers/wait-for-invoice-review.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'

export async function payingInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  lnInvoice?: string,
) {
  await ctx.reply(ctx.t('paying-invoice'))
  const invoice = decodeInvoice(lnInvoice ?? (await waitForInvoice(conversation, ctx)))
  ctx.log.debug({invoice}, 'Decoded invoice')

  const wallet = await waitForWallet(conversation, ctx)
  const isInternalWallet = wallet === 'internal'
  await waitForInvoiceReview(conversation, ctx, invoice, isInternalWallet)
  if (wallet === 'nwc' && !ctx.user.nwc) throw new NWCConnectionError()
  await ctx.replyWithChatAction('typing')

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

  const internalInvoice = await getPendingInvoiceBy({paymentRequest: invoice.paymentRequest})
  if (internalInvoice) {
    await deletePendingInvoice(internalInvoice.paymentRequest)
    await notifyInvoicePaid(internalInvoice.paymentRequest, internalInvoice.userId).catch(
      (error: unknown) => {
        ctx.log.error({error}, 'Failed to notify user about paid invoice')
      },
    )
  }

  await ctx.reply(
    ctx.t('paying-invoice.paid', {
      amount: invoice.satoshi,
      fee: msatsToSats(feesPaid),
      total: msatsToSats(invoice.millisatoshi + feesPaid),
    }),
  )
  await replyWithWallet(ctx)
}
