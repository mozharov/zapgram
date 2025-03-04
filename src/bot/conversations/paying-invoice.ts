import type {BotConversation, ConversationContext} from '../context.js'
import {waitForInvoice} from '../helpers/conversations/wait-for-invoice.js'
import {waitForWallet} from '../helpers/conversations/wait-for-wallet.js'
import {decodeInvoice} from '../../lib/decoded-invoice.js'
import {replyWithWallet} from '../helpers/messages/wallet.js'
import {msatsToSats} from '../../lib/utils/sats.js'
import {waitForInvoiceReview} from '../helpers/conversations/wait-for-invoice-review.js'
import {NWCConnectionError} from '../errors/nwc-connection.js'
import {notifyInvoicePaid} from '../../services/notify-invoice-paid.js'
import {deletePendingInvoice, getPendingInvoiceBy} from '../../models/pending-invoice.js'

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
    await ctx.user.nwc!.payInvoice(invoice.paymentRequest)
    const lookupResponse = await ctx.user.nwc!.lookupInvoice(invoice.paymentRequest)
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
      total: msatsToSats(invoice.msats + feesPaid),
    }),
  )
  await replyWithWallet(ctx)
}
